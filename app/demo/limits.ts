/**
 * Public demo AI call cap: whole demo, per rolling hour and per KST day. Counts started runs
 * (~$0.1 each); a Workflow step may retry up to twice, so the worst day is about $12.
 */
export const DEMO_DAILY_LIMIT = 40;
export const DEMO_HOURLY_LIMIT = 12;
