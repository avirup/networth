"use client";
import { createContext, useContext } from "react";
export const PeriodContext = createContext("");
export function useReportPeriod() { return useContext(PeriodContext); }
