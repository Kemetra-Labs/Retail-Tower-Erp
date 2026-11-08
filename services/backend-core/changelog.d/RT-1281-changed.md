### Changed
- RT-1281: `sales-capture.js` uses the terminal device scheme and a realistic sale body;
  `stress.js` and `baseline.js` default to lab-safe caps (20 and 5 VUs) and refuse more unless
  `LOAD_ALLOW_ABOVE_LAB_CAP=1`.
