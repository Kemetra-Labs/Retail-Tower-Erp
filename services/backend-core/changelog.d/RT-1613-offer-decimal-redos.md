### Security
- RT-1613: the Offer Engine `scaled()` trailing-zero strip is now a linear scan instead of a
  backtracking regex, closing CodeQL `js/polynomial-redos` alert 83 with identical parse results.
