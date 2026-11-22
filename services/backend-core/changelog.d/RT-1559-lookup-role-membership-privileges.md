### Security
- RT-1559: the Backend-Core boot check now refuses a forbidden table or column
  privilege that the auth lookup role reaches through a role membership it does
  not inherit (a NOINHERIT role, or `GRANT … WITH INHERIT FALSE`), since SET ROLE
  still reaches it. The error names the table and the role path
  (`via role path <lookup> -> <role>`). Which tables are forbidden is unchanged.
