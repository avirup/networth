-- Release-pinned dashboard context. A stale/removed requested release falls back to the
-- current release explicitly; every selected release receives a fresh bounded pin.
CREATE FUNCTION ops.pin_report_context(household uuid, requested uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE current_id uuid; selected_id uuid; reloaded boolean:=false; BEGIN
 IF core.member_role(household) IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT release_id INTO current_id FROM ops.current_report_release WHERE household_id=household;
 IF current_id IS NULL THEN RETURN NULL; END IF;
 IF requested IS NULL THEN selected_id:=current_id;
 ELSIF EXISTS(SELECT FROM ops.report_release r WHERE r.id=requested AND r.household_id=household AND r.state IN ('published','previous'))
 THEN selected_id:=requested;
 ELSE selected_id:=current_id; reloaded:=true;
 END IF;
 INSERT INTO ops.report_request_pin(household_id,release_id,expires_at)
 VALUES(household,selected_id,clock_timestamp()+interval '15 minutes');
 RETURN jsonb_build_object('releaseId',selected_id,'reloadedCurrent',reloaded);
END $$;
REVOKE ALL ON FUNCTION ops.pin_report_context(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.pin_report_context(uuid,uuid) TO networth_member;
--> statement-breakpoint
CREATE FUNCTION reporting.bank_dashboard(household uuid, release uuid, selected_month date, requested_scope text DEFAULT 'household', requested_as_of date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,reporting,core,pg_temp AS $$
DECLARE payload jsonb; BEGIN
 IF core.member_role(household) IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF requested_scope<>'household' THEN RAISE EXCEPTION 'unsupported report scope' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT FROM ops.report_release r WHERE r.id=release AND r.household_id=household AND r.state IN ('published','previous') AND (requested_as_of IS NULL OR requested_as_of=r.as_of))
 THEN RAISE EXCEPTION 'report release unavailable' USING ERRCODE='P0001'; END IF;
 WITH meta AS MATERIALIZED (
  SELECT * FROM ops.report_release WHERE id=release AND household_id=household
 ), manifest AS MATERIALIZED (
  SELECT * FROM ops.report_release_account WHERE release_id=release AND household_id=household
 ), accounts AS MATERIALIZED (
  SELECT a.id,a.name,a.currency,c.calculated_balance,c.reconciled_balance,c.result,m.effective_date
  FROM manifest m JOIN core.dim_account a ON a.id=m.account_id AND a.household_id=m.household_id
  JOIN reporting.bank_balance_checkpoint c ON c.run_id=m.source_run_id AND c.generation_id=m.generation_id AND c.account_id=m.account_id AND c.effective_date=m.effective_date
 ), categories AS MATERIALIZED (
  SELECT c.kind,coalesce(d.name,'Uncategorized') category,sum(c.amount_inr) amount,sum(c.posting_count) count
  FROM manifest m JOIN reporting.bank_category_movement c ON c.run_id=m.source_run_id AND c.generation_id=m.generation_id AND c.account_id=m.account_id
  LEFT JOIN core.dim_category d ON d.id=c.category_id AND d.household_id=c.household_id
  WHERE c.month=date_trunc('month',selected_month)::date GROUP BY c.kind,coalesce(d.name,'Uncategorized')
 ), month_series AS MATERIALIZED (
  SELECT generate_series(date_trunc('month',selected_month)-interval '11 months',date_trunc('month',selected_month),interval '1 month')::date AS report_month
 ), trends AS MATERIALIZED (
  SELECT months.report_month,coalesce(sum(c.amount_inr) FILTER(WHERE c.kind='income'),0) income,
   coalesce(sum(c.amount_inr) FILTER(WHERE c.kind='expense'),0) expense
  FROM month_series months LEFT JOIN manifest m ON true
  LEFT JOIN reporting.bank_category_movement c ON c.run_id=m.source_run_id AND c.generation_id=m.generation_id AND c.account_id=m.account_id AND c.month=months.report_month
  GROUP BY months.report_month
 ), movement AS MATERIALIZED (
  SELECT coalesce(sum(c.cash_delta),0) net_cash
  FROM manifest m JOIN reporting.bank_account_movement c ON c.run_id=m.source_run_id AND c.generation_id=m.generation_id AND c.account_id=m.account_id
  WHERE c.effective_date>=date_trunc('month',selected_month)::date AND c.effective_date<(date_trunc('month',selected_month)+interval '1 month')::date AND c.ledger_kind='asset'
 ), debt AS MATERIALIZED (
  SELECT coalesce(-sum(p.book_amount_inr),0) principal
  FROM meta JOIN core.import_batch b ON b.household_id=household AND b.revision<=meta.source_revision
  JOIN core.transaction_event e ON e.batch_id=b.id AND e.household_id=b.household_id AND e.state='confirmed' AND e.kind='card_repayment'
  JOIN core.fact_posting p ON p.event_id=e.id AND p.household_id=e.household_id
  JOIN core.ledger_account l ON l.id=p.ledger_account_id AND l.household_id=p.household_id AND l.kind='asset'
  JOIN manifest m ON m.account_id=l.account_id
  WHERE e.effective_date>=date_trunc('month',selected_month)::date AND e.effective_date<(date_trunc('month',selected_month)+interval '1 month')::date
 ), expense_amounts AS MATERIALIZED (
  SELECT e.id,e.household_id,e.effective_date,sum(p.book_amount_inr) amount,max(cp.name) counterparty
  FROM meta JOIN core.import_batch b ON b.household_id=household AND b.revision<=meta.source_revision
  JOIN core.transaction_event e ON e.batch_id=b.id AND e.household_id=b.household_id AND e.state='confirmed' AND e.kind='expense'
  JOIN core.fact_posting p ON p.event_id=e.id AND p.household_id=e.household_id
  JOIN core.ledger_account l ON l.id=p.ledger_account_id AND l.household_id=p.household_id AND l.kind='expense'
  LEFT JOIN core.dim_counterparty cp ON cp.id=p.counterparty_id AND cp.household_id=p.household_id
  WHERE e.effective_date>=date_trunc('month',selected_month)::date AND e.effective_date<(date_trunc('month',selected_month)+interval '1 month')::date
   AND EXISTS(SELECT FROM core.fact_posting bank_post JOIN core.ledger_account bank_ledger ON bank_ledger.id=bank_post.ledger_account_id AND bank_ledger.household_id=bank_post.household_id
    JOIN manifest included ON included.account_id=bank_ledger.account_id WHERE bank_post.event_id=e.id AND bank_post.household_id=e.household_id)
  GROUP BY e.id,e.household_id,e.effective_date HAVING sum(p.book_amount_inr)>0
 ), expense_sources AS MATERIALIZED (
  SELECT a.id,max(s.payload->>'description') description FROM expense_amounts a
  LEFT JOIN core.event_source_link link ON link.event_id=a.id AND link.household_id=a.household_id
  LEFT JOIN core.source_record s ON s.id=link.source_id AND s.household_id=link.household_id GROUP BY a.id
 ), expense_events AS MATERIALIZED (
  SELECT a.id,a.effective_date,a.amount,coalesce(a.counterparty,s.description,'Unspecified counterparty') counterparty
  FROM expense_amounts a LEFT JOIN expense_sources s ON s.id=a.id ORDER BY a.amount DESC,a.effective_date,a.id LIMIT 1
 ), quality AS MATERIALIZED (
  SELECT count(*) FILTER(WHERE b.completeness<>'complete') incomplete_batches,min(b.coverage_start) coverage_start,max(b.coverage_end) coverage_end,max(b.confirmed_at) newest_import
  FROM meta JOIN core.import_batch b ON b.household_id=household AND b.revision<=meta.source_revision
  JOIN manifest m ON m.account_id=b.account_id
 ), operation AS MATERIALIZED (
  SELECT (SELECT revision FROM ops.source_revision WHERE household_id=household) latest_revision,
   latest.state calculation_state,budget.state budget_state,budget.reason pause_reason,delivery.state delivery_state
  FROM meta LEFT JOIN LATERAL (SELECT r.* FROM ops.calculation_run r WHERE r.household_id=household AND r.source_revision>meta.source_revision ORDER BY r.source_revision DESC,r.created_at DESC LIMIT 1) latest ON true
  LEFT JOIN ops.calculation_budget budget ON budget.run_id=latest.id
  LEFT JOIN LATERAL (SELECT d.state FROM ops.outbox_event o JOIN ops.workflow_delivery d ON d.outbox_id=o.id AND d.household_id=o.household_id
   WHERE o.household_id=household AND o.revision>meta.source_revision ORDER BY o.revision DESC LIMIT 1) delivery ON true
 ), totals AS MATERIALIZED (
  SELECT coalesce((SELECT sum(amount) FROM categories WHERE kind='income'),0) income,
   coalesce((SELECT sum(amount) FROM categories WHERE kind='expense'),0) expense,
   (SELECT net_cash FROM movement) net_cash,(SELECT principal FROM debt) debt
 )
 SELECT jsonb_build_object(
  'release',jsonb_build_object('id',meta.id,'asOf',meta.as_of,'sourceRevision',meta.source_revision,'publishedAt',meta.published_at),
  'scope',jsonb_build_object('kind','household','id',household,'asOf',meta.as_of),
  'summary',jsonb_build_object('knownAssetsInr',coalesce((SELECT sum(reconciled_balance) FROM accounts WHERE currency='INR'),0)::text,
   'netWorthInr',coalesce((SELECT sum(reconciled_balance) FROM accounts WHERE currency='INR'),0)::text,
   'monthlyIncomeInr',totals.income::text,'monthlyExpenseInr',totals.expense::text,
   'unknownAccountCount',(SELECT count(*) FROM accounts WHERE currency<>'INR' OR reconciled_balance IS NULL)),
  'accounts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'currency',currency,'effectiveDate',effective_date,
   'calculatedBalance',calculated_balance::text,'reconciledBalance',reconciled_balance::text,'status',result->>'status','reasons',result->'reasons') ORDER BY name,id) FROM accounts),'[]'::jsonb),
  'categories',coalesce((SELECT jsonb_agg(jsonb_build_object('kind',kind,'category',category,'amountInr',amount::text,'postingCount',count) ORDER BY kind,amount DESC,category) FROM categories),'[]'::jsonb),
  'trends',coalesce((SELECT jsonb_agg(jsonb_build_object('month',report_month,'incomeInr',income::text,'expenseInr',expense::text) ORDER BY report_month) FROM trends),'[]'::jsonb),
  'cashFlow',jsonb_build_object('recognizedIncomeInr',totals.income::text,'recognizedExpenseInr',totals.expense::text,
   'debtPrincipalInr',totals.debt::text,'investmentAllocationInr',NULL,'investmentReason','Investment allocation is unavailable until investment accounts and custody boundaries are implemented.',
   'otherFundingInr',(totals.net_cash-totals.income+totals.expense+totals.debt)::text,'netCashMovementInr',totals.net_cash::text),
  'largestExpense',(SELECT jsonb_build_object('eventId',id,'date',effective_date,'amountInr',amount::text,'counterparty',counterparty) FROM expense_events),
  'quality',jsonb_build_object('status',CASE WHEN operation.budget_state='paused' OR operation.delivery_state='paused' THEN 'paused' WHEN operation.latest_revision>meta.source_revision THEN 'stale'
    WHEN (SELECT count(*) FROM accounts WHERE currency<>'INR' OR reconciled_balance IS NULL)>0 OR quality.incomplete_batches>0 THEN 'incomplete' ELSE 'complete' END,
   'coverageStart',quality.coverage_start,'coverageEnd',quality.coverage_end,'newestImportAt',quality.newest_import,
   'incompleteBatchCount',quality.incomplete_batches,'latestSourceRevision',operation.latest_revision,'pauseReason',operation.pause_reason)
 ) INTO payload FROM meta CROSS JOIN totals CROSS JOIN quality CROSS JOIN operation;
 IF octet_length(payload::text)>3000000 THEN RAISE EXCEPTION 'report response exceeds budget' USING ERRCODE='54000'; END IF;
 RETURN payload;
END $$;
REVOKE ALL ON FUNCTION reporting.bank_dashboard(uuid,uuid,date,text,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.bank_dashboard(uuid,uuid,date,text,date) TO networth_member;
--> statement-breakpoint
CREATE FUNCTION reporting.bank_activity(household uuid, release uuid, selected_month date, page_limit integer, before_date date DEFAULT NULL, before_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,reporting,core,pg_temp AS $$
DECLARE payload jsonb; BEGIN
 IF core.member_role(household) IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 1000 OR ((before_date IS NULL)<>(before_id IS NULL)) THEN RAISE EXCEPTION 'invalid report page' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT FROM ops.report_release r WHERE r.id=release AND r.household_id=household AND r.state IN ('published','previous'))
 THEN RAISE EXCEPTION 'report release unavailable' USING ERRCODE='P0001'; END IF;
 WITH meta AS MATERIALIZED (SELECT * FROM ops.report_release WHERE id=release),
 manifest AS MATERIALIZED (SELECT * FROM ops.report_release_account WHERE release_id=release AND household_id=household),
 selected AS MATERIALIZED (
  SELECT e.id,e.kind,e.effective_date,e.quality,b.id batch_id,b.revision,b.confirmed_at
  FROM meta JOIN core.import_batch b ON b.household_id=household AND b.revision<=meta.source_revision
  JOIN core.transaction_event e ON e.batch_id=b.id AND e.household_id=b.household_id AND e.state='confirmed'
  WHERE e.effective_date>=date_trunc('month',selected_month)::date AND e.effective_date<(date_trunc('month',selected_month)+interval '1 month')::date
   AND (before_date IS NULL OR (e.effective_date,e.id)<(before_date,before_id))
   AND EXISTS(SELECT FROM core.fact_posting p JOIN core.ledger_account l ON l.id=p.ledger_account_id AND l.household_id=p.household_id
    JOIN manifest m ON m.account_id=l.account_id WHERE p.event_id=e.id AND p.household_id=e.household_id)
  ORDER BY e.effective_date DESC,e.id DESC LIMIT page_limit+1
 ), page AS MATERIALIZED (SELECT * FROM selected ORDER BY effective_date DESC,id DESC LIMIT page_limit),
 amounts AS MATERIALIZED (
  SELECT p.event_id,
   coalesce(sum(CASE WHEN l.kind='income' THEN -p.book_amount_inr WHEN l.kind='expense' THEN p.book_amount_inr END),
    abs(sum(p.book_amount_inr) FILTER(WHERE l.kind='asset' AND EXISTS(SELECT FROM manifest m WHERE m.account_id=l.account_id)))) amount,
   string_agg(DISTINCT c.name,', ' ORDER BY c.name) category,
   string_agg(DISTINCT a.name,', ' ORDER BY a.name) accounts
  FROM core.fact_posting p JOIN page e ON e.id=p.event_id
  JOIN core.ledger_account l ON l.id=p.ledger_account_id AND l.household_id=p.household_id
  LEFT JOIN core.dim_category c ON c.id=p.category_id AND c.household_id=p.household_id
  LEFT JOIN core.dim_account a ON a.id=l.account_id AND a.household_id=l.household_id AND EXISTS(SELECT FROM manifest m WHERE m.account_id=a.id)
  GROUP BY p.event_id
 ), sources AS MATERIALIZED (
  SELECT link.event_id,jsonb_agg(jsonb_build_object('id',s.id,'rowNumber',s.row_number,'rowId',s.payload->>'row_id',
   'description',s.payload->>'description','transactionReference',nullif(s.payload->>'transaction_ref','')) ORDER BY s.row_number,s.id) rows,
   coalesce(max(s.payload->>'description'),'Imported financial event') description
  FROM core.event_source_link link JOIN page e ON e.id=link.event_id
  JOIN core.source_record s ON s.id=link.source_id AND s.household_id=link.household_id GROUP BY link.event_id
 ), items AS MATERIALIZED (
  SELECT e.*,a.amount,a.category,a.accounts,s.rows,s.description FROM page e JOIN amounts a ON a.event_id=e.id LEFT JOIN sources s ON s.event_id=e.id
 )
 SELECT jsonb_build_object('releaseId',release,'items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'kind',kind,'date',effective_date,
   'description',description,'amountInr',amount::text,'category',category,'accounts',accounts,'quality',quality,
   'import',jsonb_build_object('batchId',batch_id,'revision',revision,'confirmedAt',confirmed_at),'sources',coalesce(rows,'[]'::jsonb)) ORDER BY effective_date DESC,id DESC) FROM items),'[]'::jsonb),
  'hasMore',(SELECT count(*)>page_limit FROM selected)) INTO payload;
 IF octet_length(payload::text)>3000000 THEN RAISE EXCEPTION 'report response exceeds budget' USING ERRCODE='54000'; END IF;
 RETURN payload;
END $$;
REVOKE ALL ON FUNCTION reporting.bank_activity(uuid,uuid,date,integer,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.bank_activity(uuid,uuid,date,integer,date,uuid) TO networth_member;
UPDATE core.system_installation SET schema_version=10;
