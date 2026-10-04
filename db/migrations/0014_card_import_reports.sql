-- Card imports reuse the existing economic event vocabulary. The source row retains
-- card_purchase/card_refund/card_interest/card_fee; ledger events are expense,
-- expense_refund and card_repayment so bank and card evidence can link one repayment.
CREATE OR REPLACE FUNCTION core.check_event_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event core.transaction_event; n bigint; total numeric; batch_schema text; boundary_kind text; BEGIN
  SELECT e.* INTO event FROM core.transaction_event e WHERE e.id=NEW.id;
  SELECT b.schema_version INTO batch_schema FROM core.import_batch b WHERE b.id=event.batch_id AND b.household_id=event.household_id;
  SELECT count(*),sum(book_amount_inr) INTO n,total FROM core.fact_posting WHERE household_id=event.household_id AND event_id=event.id;
  IF event.state<>'confirmed' OR n<2 OR total<>0 OR NOT EXISTS(SELECT FROM core.event_source_link WHERE household_id=event.household_id AND event_id=event.id) THEN RAISE EXCEPTION 'event must be confirmed, sourced and exactly balanced with at least two legs' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT FROM core.import_batch WHERE id=event.batch_id AND event.effective_date BETWEEN coverage_start AND coverage_end) THEN RAISE EXCEPTION 'event outside reviewed coverage' USING ERRCODE='23514'; END IF;
  SELECT l.kind INTO boundary_kind FROM core.fact_posting p JOIN core.ledger_account l ON l.id=p.ledger_account_id AND l.household_id=p.household_id
   WHERE p.event_id=event.id AND l.kind IN ('asset','liability') LIMIT 1;
  IF event.kind NOT IN ('reversal','fx_conversion') AND (
    n<>2 OR boundary_kind IS NULL OR
    (batch_schema='card-v1' AND (
      (event.kind IN ('expense','expense_refund') AND (boundary_kind<>'liability' OR EXISTS(SELECT FROM core.fact_posting p JOIN core.ledger_account l ON l.id=p.ledger_account_id WHERE p.event_id=event.id AND l.kind NOT IN ('liability','expense')))) OR
      (event.kind='card_repayment' AND EXISTS(SELECT FROM core.fact_posting p JOIN core.ledger_account l ON l.id=p.ledger_account_id WHERE p.event_id=event.id AND l.kind NOT IN ('asset','liability'))) OR
      (event.kind='opening_balance' AND (boundary_kind<>'liability' OR EXISTS(SELECT FROM core.fact_posting p JOIN core.ledger_account l ON l.id=p.ledger_account_id WHERE p.event_id=event.id AND l.kind NOT IN ('liability','equity')))) OR
      event.kind NOT IN ('expense','expense_refund','card_repayment','opening_balance') OR
      EXISTS(SELECT FROM core.fact_posting p JOIN core.ledger_account l ON l.id=p.ledger_account_id WHERE p.event_id=event.id AND (
        (event.kind='expense' AND ((l.kind='liability' AND p.book_amount_inr>=0) OR (l.kind='expense' AND p.book_amount_inr<=0))) OR
        (event.kind='expense_refund' AND ((l.kind='liability' AND p.book_amount_inr<=0) OR (l.kind='expense' AND p.book_amount_inr>=0))) OR
        (event.kind='card_repayment' AND ((l.kind='asset' AND p.book_amount_inr>=0) OR (l.kind='liability' AND p.book_amount_inr<=0))) OR
        (event.kind='opening_balance' AND ((l.kind='liability' AND p.book_amount_inr>=0) OR (l.kind='equity' AND p.book_amount_inr<=0)))
      ))
    )) OR
    (batch_schema<>'card-v1' AND (
      NOT EXISTS(SELECT FROM core.fact_posting p JOIN core.ledger_account l ON l.id=p.ledger_account_id WHERE p.event_id=event.id AND l.kind='asset') OR
      EXISTS(SELECT FROM core.fact_posting p JOIN core.ledger_account l ON l.id=p.ledger_account_id WHERE p.event_id=event.id AND (
        (event.kind IN ('income','income_reversal') AND l.kind NOT IN ('asset','income')) OR
        (event.kind IN ('expense','expense_refund') AND l.kind NOT IN ('asset','expense')) OR
        (event.kind='transfer' AND l.kind<>'asset') OR
        (event.kind='card_repayment' AND l.kind NOT IN ('asset','liability')) OR
        (event.kind IN ('opening_balance','unresolved_reconciliation') AND l.kind NOT IN ('asset','equity')) OR
        (event.kind IN ('income','expense_refund') AND ((l.kind='asset' AND p.book_amount_inr<=0) OR (l.kind<>'asset' AND p.book_amount_inr>=0))) OR
        (event.kind IN ('expense','income_reversal','card_repayment') AND ((l.kind='asset' AND p.book_amount_inr>=0) OR (l.kind<>'asset' AND p.book_amount_inr<=0)))
      )) OR (event.kind<>'transfer' AND (SELECT count(*) FROM core.fact_posting p JOIN core.ledger_account l ON l.id=p.ledger_account_id WHERE p.event_id=event.id AND l.kind='asset')<>1)
    ))
  ) THEN RAISE EXCEPTION 'posting shape does not match event type' USING ERRCODE='23514'; END IF;
  IF event.reverses_id IS NOT NULL AND (NOT EXISTS(SELECT FROM core.transaction_event WHERE id=event.reverses_id AND state='confirmed') OR EXISTS(
    (SELECT ledger_account_id,currency,native_amount,book_amount_inr,category_id,counterparty_id FROM core.fact_posting WHERE event_id=event.id EXCEPT ALL SELECT ledger_account_id,currency,-native_amount,-book_amount_inr,category_id,counterparty_id FROM core.fact_posting WHERE event_id=event.reverses_id)
    UNION ALL
    (SELECT ledger_account_id,currency,-native_amount,-book_amount_inr,category_id,counterparty_id FROM core.fact_posting WHERE event_id=event.reverses_id EXCEPT ALL SELECT ledger_account_id,currency,native_amount,book_amount_inr,category_id,counterparty_id FROM core.fact_posting WHERE event_id=event.id)
  )) THEN RAISE EXCEPTION 'reversal must negate the original postings exactly' USING ERRCODE='23514'; END IF;
  IF event.replaces_id IS NOT NULL AND NOT EXISTS(SELECT FROM core.transaction_event WHERE household_id=event.household_id AND reverses_id=event.replaces_id AND state='confirmed') THEN RAISE EXCEPTION 'replacement requires a traceable reversal' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Account contribution pages keep their existing version. The calculation is extended
-- to anchor spending categories to either the bank asset or card liability boundary.
CREATE OR REPLACE FUNCTION ops.bank_expected_contributions(inputs jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 WITH events AS (SELECT value e FROM jsonb_array_elements(inputs->'events')), legs AS (
  SELECT e,coalesce(e->>'reversedKind',e->>'kind') AS event_kind,p.*
  FROM events CROSS JOIN LATERAL jsonb_to_recordset(e->'legs') AS p("accountId" uuid,kind text,currency text,"nativeAmount" numeric,"bookAmountInr" numeric,"categoryId" uuid)
 ), accounts AS (
  SELECT "accountId",currency,kind AS "ledgerKind",(e->>'effectiveDate')::date AS date,
   sum("nativeAmount") AS "nativeDelta",sum("bookAmountInr") AS "bookDeltaInr",
   sum(CASE WHEN kind='asset' AND event_kind NOT IN ('opening_balance','unresolved_reconciliation') THEN "nativeAmount" ELSE 0 END) AS "cashDelta",
   sum(CASE WHEN event_kind='opening_balance' THEN "nativeAmount" ELSE 0 END) AS "openingDelta",
   sum(CASE WHEN event_kind='unresolved_reconciliation' THEN "nativeAmount" ELSE 0 END) AS "unresolvedDelta",
   count(*) AS "postingCount",bool_or(e->>'quality'<>'complete') AS "incompleteEvidence"
  FROM legs WHERE kind IN ('asset','liability') GROUP BY "accountId",currency,kind,e->>'effectiveDate'
 ), categories AS (
  SELECT (SELECT (a->>'accountId')::uuid FROM jsonb_array_elements(e->'legs') a WHERE a->>'kind' IN ('asset','liability') LIMIT 1) AS "accountId",
   date_trunc('month',(e->>'effectiveDate')::date)::date AS month,kind,"categoryId",
   sum(CASE WHEN kind='income' THEN -"bookAmountInr" ELSE "bookAmountInr" END) AS "amountInr",count(*) AS "postingCount"
  FROM legs WHERE kind IN ('income','expense') GROUP BY 1,2,3,4
 ) SELECT jsonb_build_object(
 'accountMovements',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY "accountId",currency,"ledgerKind",date) FROM accounts a),'[]'::jsonb),
 'categoryMovements',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY "accountId",month,kind,"categoryId") FROM categories c),'[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION ops.bank_expected_contributions(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION reporting.card_liabilities(household uuid, release uuid, selected_month date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,reporting,core,pg_temp AS $$
DECLARE payload jsonb; BEGIN
 IF core.member_role(household) IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT FROM ops.report_release r WHERE r.id=release AND r.household_id=household AND r.state IN ('published','previous'))
 THEN RAISE EXCEPTION 'report release unavailable' USING ERRCODE='P0001'; END IF;
 WITH meta AS MATERIALIZED (SELECT * FROM ops.report_release WHERE id=release AND household_id=household),
 cards AS MATERIALIZED (SELECT a.* FROM core.dim_account a WHERE a.household_id=household AND a.kind='credit_card' AND EXISTS(SELECT FROM core.import_batch b,meta WHERE b.household_id=a.household_id AND b.account_id=a.id AND b.revision<=meta.source_revision)),
 statements AS MATERIALIZED (
  SELECT DISTINCT ON(o.account_id) o.account_id,o.id observation_id,o.as_of statement_date,o.balance statement_outstanding,c.payment_due_date,c.minimum_due,b.revision
  FROM cards a JOIN core.fact_statement_observation o ON o.household_id=a.household_id AND o.account_id=a.id AND o.kind='closing'
  JOIN core.card_statement c ON c.household_id=o.household_id AND c.observation_id=o.id
  JOIN core.source_record s ON s.household_id=o.household_id AND s.id=o.source_id JOIN core.import_batch b ON b.household_id=s.household_id AND b.id=s.batch_id
  CROSS JOIN meta WHERE o.as_of<=meta.as_of AND b.revision<=meta.source_revision ORDER BY o.account_id,o.as_of DESC,b.revision DESC,o.id
 ), coverage AS MATERIALIZED (
  SELECT st.account_id,meta.as_of=st.statement_date OR coalesce((
    SELECT range_agg(daterange(greatest(b.coverage_start,st.statement_date+1),b.coverage_end,'[]')) @> daterange(st.statement_date+1,meta.as_of,'[]')
    FROM core.import_batch b WHERE b.household_id=household AND b.account_id=st.account_id AND b.revision<=meta.source_revision
      AND b.completeness='complete' AND b.coverage_end>st.statement_date AND b.coverage_start<=meta.as_of
  ),false) complete FROM statements st CROSS JOIN meta
 ), later_movements AS MATERIALIZED (
  SELECT l.account_id,sum(p.native_amount) movement
  FROM statements st JOIN core.ledger_account l ON l.household_id=household AND l.account_id=st.account_id AND l.kind='liability'
  JOIN core.fact_posting p ON p.household_id=l.household_id AND p.ledger_account_id=l.id
  JOIN core.transaction_event e ON e.household_id=p.household_id AND e.id=p.event_id AND e.state='confirmed'
  JOIN core.import_batch b ON b.household_id=e.household_id AND b.id=e.batch_id CROSS JOIN meta
  WHERE e.effective_date>st.statement_date AND e.effective_date<=meta.as_of AND b.revision<=meta.source_revision AND e.kind<>'reversal'
   AND NOT EXISTS(SELECT FROM core.transaction_event r JOIN core.import_batch rb ON rb.id=r.batch_id AND rb.household_id=r.household_id WHERE r.household_id=e.household_id AND r.reverses_id=e.id AND rb.revision<=meta.source_revision)
  GROUP BY l.account_id
 ), positions AS MATERIALIZED (
  SELECT a.id,a.name,a.masked_reference,st.observation_id,st.statement_date,st.statement_outstanding,st.payment_due_date,st.minimum_due,
   CASE WHEN st.statement_outstanding IS NULL OR coverage.complete IS DISTINCT FROM true THEN NULL ELSE st.statement_outstanding-coalesce(m.movement,0) END current_outstanding,
   CASE WHEN st.observation_id IS NULL THEN 'missing_statement' WHEN st.statement_outstanding IS NULL THEN 'unknown_statement' WHEN coverage.complete IS DISTINCT FROM true THEN 'coverage_gap' ELSE NULL END reason
  FROM cards a LEFT JOIN statements st ON st.account_id=a.id LEFT JOIN coverage ON coverage.account_id=a.id LEFT JOIN later_movements m ON m.account_id=a.id
 ), terms AS MATERIALIZED (
  SELECT DISTINCT ON(t.facility_id) t.facility_id,f.name,t.effective_date,t.limit_inr,b.revision,t.source_id
  FROM core.credit_facility_term t JOIN core.credit_facility f ON f.household_id=t.household_id AND f.id=t.facility_id
  JOIN core.source_record s ON s.household_id=t.household_id AND s.id=t.source_id JOIN core.import_batch b ON b.household_id=s.household_id AND b.id=s.batch_id CROSS JOIN meta
  WHERE t.household_id=household AND t.effective_date<=meta.as_of AND b.revision<=meta.source_revision ORDER BY t.facility_id,t.effective_date DESC,b.revision DESC
 ), links AS MATERIALIZED (
  SELECT DISTINCT ON(l.account_id) l.account_id,l.facility_id,l.effective_date,b.revision,l.source_id
  FROM core.account_facility_link l JOIN core.source_record s ON s.household_id=l.household_id AND s.id=l.source_id
  JOIN core.import_batch b ON b.household_id=s.household_id AND b.id=s.batch_id CROSS JOIN meta
  WHERE l.household_id=household AND l.effective_date<=meta.as_of AND b.revision<=meta.source_revision ORDER BY l.account_id,l.effective_date DESC,b.revision DESC
 ), category_rows AS MATERIALIZED (
  SELECT date_trunc('month',e.effective_date)::date report_month,coalesce(c.name,'Uncategorized') category,sum(p.book_amount_inr) amount,count(*) count
  FROM core.fact_posting p JOIN core.ledger_account l ON l.id=p.ledger_account_id AND l.household_id=p.household_id AND l.kind='expense'
  JOIN core.transaction_event e ON e.id=p.event_id AND e.household_id=p.household_id JOIN core.import_batch b ON b.id=e.batch_id AND b.household_id=e.household_id
  LEFT JOIN core.dim_category c ON c.id=p.category_id AND c.household_id=p.household_id CROSS JOIN meta
  WHERE p.household_id=household AND b.schema_version='card-v1' AND b.revision<=meta.source_revision
   AND e.effective_date>=(date_trunc('month',selected_month)-interval '11 months')::date AND e.effective_date<(date_trunc('month',selected_month)+interval '1 month')::date
   AND (e.kind IN ('expense','expense_refund') OR (e.kind='reversal' AND EXISTS(SELECT FROM core.transaction_event original WHERE original.id=e.reverses_id AND original.kind IN ('expense','expense_refund'))))
  GROUP BY date_trunc('month',e.effective_date)::date,coalesce(c.name,'Uncategorized')
 ), expense_events AS MATERIALIZED (
  SELECT e.id,e.effective_date,sum(p.book_amount_inr) amount,coalesce(max(s.payload->>'description'),'Imported card expense') description
  FROM core.transaction_event e JOIN core.import_batch b ON b.id=e.batch_id AND b.household_id=e.household_id
  JOIN core.fact_posting p ON p.event_id=e.id AND p.household_id=e.household_id
  JOIN core.ledger_account l ON l.id=p.ledger_account_id AND l.household_id=p.household_id AND l.kind='expense'
  LEFT JOIN core.event_source_link link ON link.event_id=e.id AND link.household_id=e.household_id LEFT JOIN core.source_record s ON s.id=link.source_id AND s.household_id=link.household_id CROSS JOIN meta
  WHERE e.household_id=household AND b.schema_version='card-v1' AND b.revision<=meta.source_revision AND e.kind='expense'
   AND e.effective_date>=date_trunc('month',selected_month)::date AND e.effective_date<(date_trunc('month',selected_month)+interval '1 month')::date
   AND NOT EXISTS(SELECT FROM core.transaction_event r JOIN core.import_batch rb ON rb.id=r.batch_id AND rb.household_id=r.household_id WHERE r.household_id=e.household_id AND r.reverses_id=e.id AND rb.revision<=meta.source_revision)
  GROUP BY e.id,e.effective_date HAVING sum(p.book_amount_inr)>0 ORDER BY amount DESC,e.effective_date,e.id LIMIT 1
 )
 SELECT jsonb_build_object(
  'positions',coalesce((SELECT jsonb_agg(jsonb_build_object('accountId',id,'name',name,'maskedReference',masked_reference,'observationId',observation_id,'statementDate',statement_date,
    'statementOutstandingInr',statement_outstanding::text,'currentOutstandingInr',current_outstanding::text,'paymentDueDate',payment_due_date,'minimumDueInr',minimum_due::text,'reason',reason) ORDER BY name,id) FROM positions),'[]'::jsonb),
  'terms',coalesce((SELECT jsonb_agg(jsonb_build_object('facilityId',facility_id,'name',name,'effectiveDate',effective_date,'limitInr',limit_inr::text,'revision',revision,'sourceId',source_id) ORDER BY facility_id) FROM terms),'[]'::jsonb),
  'links',coalesce((SELECT jsonb_agg(jsonb_build_object('accountId',account_id,'facilityId',facility_id,'effectiveDate',effective_date,'revision',revision,'sourceId',source_id) ORDER BY account_id) FROM links),'[]'::jsonb),
  'categories',coalesce((SELECT jsonb_agg(jsonb_build_object('category',category,'amountInr',amount::text,'postingCount',count) ORDER BY amount DESC,category) FROM category_rows WHERE report_month=date_trunc('month',selected_month)::date),'[]'::jsonb),
  'trends',coalesce((SELECT jsonb_agg(jsonb_build_object('month',months.report_month,'expenseInr',coalesce(rows.amount,0)::text) ORDER BY months.report_month) FROM
    (SELECT generate_series(date_trunc('month',selected_month)-interval '11 months',date_trunc('month',selected_month),interval '1 month')::date AS report_month) months
    LEFT JOIN (SELECT report_month,sum(amount) amount FROM category_rows GROUP BY report_month) rows USING(report_month)),'[]'::jsonb),
  'largestExpense',(SELECT jsonb_build_object('eventId',id,'date',effective_date,'amountInr',amount::text,'counterparty',description) FROM expense_events)
 ) INTO payload;
 IF octet_length(payload::text)>3000000 THEN RAISE EXCEPTION 'card report response exceeds budget' USING ERRCODE='54000'; END IF;
 RETURN payload;
END $$;
REVOKE ALL ON FUNCTION reporting.card_liabilities(uuid,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.card_liabilities(uuid,uuid,date) TO networth_member;
UPDATE core.system_installation SET schema_version=13;
