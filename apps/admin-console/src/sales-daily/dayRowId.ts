/** The id of a day row in the first report table, for the chart bars to point at (RT-821, RT-823). */
export const dayRowId = (date: string) => `sales-daily-day-${date}`;

/**
 * Moves focus to the table row of a day (a hash link does not focus a `<tr>`).
 * Used by a chart bar (RT-823) and by the day panel's row link (RT-1020).
 */
export function goToDayRow(event: React.MouseEvent, date: string): void {
  const row = document.getElementById(dayRowId(date));
  if (!row) return;
  event.preventDefault();
  row.focus();
}
