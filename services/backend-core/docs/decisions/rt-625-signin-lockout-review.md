# RT-625 — Sign-in lockout redesign: security review and recommended numbers (O9)

| | |
|---|---|
| **Jira** | RT-625 (from RT-574 §5 issue 5c, open owner decision O9). Owner ruling c13717 (2026-10-24): "REVIEW FIRST, NUMBERS NOT APPROVED". |
| **Work Mode** | Docs/Planning (owner decision in chat, 2026-11-01: RT-625 is review only). The Jira field still reads Implementation. No runtime code, contract, config or test changes. |
| **Status** | **Proposed.** The numbers and the shape below need the owner's sign-off. Opening the implementation issue is the owner's call after that. |
| **Baseline** | `Kemetra-Labs/Retail-Tower-Erp` `origin/main` = `3fe42b60` (#204). Every line reference below is to that commit. RT-626 is changing `auth.controller.ts` and `rate-limit.ts` in parallel, so the line numbers may move; the behaviour described here is what the implementation must start from. |
| **Inputs** | `docs/decisions/rt-574-console-rate-limiting.md` §5 issue 5c and O9 (`:351-354`, `:433`); RT-136 (failure-only account bucket); RT-628 (fail closed, O6); RT-624 (`TRUST_PROXY`). |

---

## 0. Summary

| Question | Answer |
|---|---|
| Is today's lockout exploitable? | **Yes.** One IP sending 5 wrong passwords per 15 minutes (20 per hour) keeps any account locked for as long as it likes. That stays under the per-IP limit of 30 per hour, so the attacker is never throttled (§2.1). |
| Does the candidate (email, IP) 5/15 + email-only 20/15 fix it? | It fixes the **single-IP** case, provided the check order and release rules in §4.2 are kept. It does **not** fix a distributed lockout: 4 IPs (or 4 IPv6 /64s) lock the owner out everywhere (§3.2). |
| What does it cost? | The per-account guess budget for a distributed attacker rises 4×, from 480 to 1,920 guesses per day. A single IP's budget is unchanged at 480 per day (§3.2). |
| Recommendation | **Approve option A (the candidate shape) with pair 5 / 15 min and email-only 20 / 15 min**, plus the five preconditions in §5.2 (check order, release rules, `TRUST_PROXY` hop count, IPv6 /64, reset clears the counters). Keep option B (trusted-device cookie) as the named next step if a distributed lockout is ever seen (§5.3). |
| Owner decisions needed | D1 the numbers; D2 whether a successful password reset clears the sign-in counters; D3 whether `TRUST_PROXY_REQUIRED=true` becomes a precondition for shipping; D4 whether to open the PII-in-keys follow-up (§7). |

---

## 1. Current behaviour (verified at `3fe42b60`)

### 1.1 The sign-in path

`AuthController.signIn` (`apps/api/src/auth/auth.controller.ts:129-168`):

1. `assertTrustedOrigin` (`:139`), then `ip = readClientIp(req)` (`:140`). `readClientIp` (`:410-416`) returns Express `req.ip`, which honours `trust proxy`, falling back to the socket address.
2. **`signin_account`** is reserved first, keyed by `body.email` (`:146`), policy `signInPerAccount` = **5 per 15 min** (`rate-limit.ts:73`). The email has been trimmed and lowercased by the shared `Email` schema (`packages/shared/src/zod/base.ts:15-21`), so case variants share one bucket.
3. **`signin_ip`** is reserved next, keyed by the IP (`:149`), policy `signInPerIp` = **30 per hour** (`rate-limit.ts:74`). It counts **every** attempt, successful or not; it is never released.
4. `authService.signIn` runs (`:150`).
5. RT-136 release rules (`:151-160`): the `signin_account` hit is released on success (`:160`) and on any error that is **not** an `UnauthorizedException` (`:155-157`). That covers a `signin_ip` 429, a 503 from the limiter, a 503 from the identity provider and any 500. Only credential failures stay counted.

A refused bucket throws a 429 with `Retry-After` from `guardRateLimit` (`:363-408`; the throw is at `:405`). A refusal at `:146` happens **before** the `try`, so that over-limit hit is not released. A refusal at `:149` is inside the `try`, so the account reservation is given back (test `auth.controller.unit.spec.ts:443`).

### 1.2 The counter

`RateLimiter.check` (`rate-limit.ts:169-182`) is one atomic `incrWindow` (INCR, plus PEXPIRE only when the key has **no** TTL; `ioredis-idempotency-adapter.ts:34-41`). So:

- The window is **fixed**: it starts at the first counted hit and ends 15 min later.
- Over-limit hits keep raising the count, but they **never extend the lockout**. The lock always ends when the first hit's window ends. (The brief's "the counter keeps growing" is true, but it has no effect on the lock's length.)
- A fixed window admits up to 2 × limit across a window edge (`rate-limit.ts:29-31`), so the worst-case burst against one account today is 10 guesses in a short span.
- `release` (`:192-196`) is a DECR; a negative result deletes the key.

The key is `rl:<bucket>:<identifier>` (`:150-152`), so today Redis holds `rl:signin_account:<raw lowercased email>` and `rl:signin_ip:<ip>`.

### 1.3 Non-disclosure

- Every credential failure (unknown email, wrong password, SSO-only, soft-deleted, provider refusal) is the same `UnauthorizedException("Invalid credentials")` (`auth.service.ts:229-276`, throw at `:276`).
- An unknown email is verified against `DUMMY_PHC` (`:235`), so the timing does not reveal whether the account exists.
- The lockout counts unknown and known emails alike, and the 429 is the same for both. An attacker cannot use the lockout to enumerate accounts.

### 1.4 Redis outage (RT-628)

`checkWithin` (`public-auth-limiter.ts:89-111`) bounds each limiter call with `PUBLIC_AUTH_LIMITER_TIMEOUT_MS` (default 1 s). A timeout or error answers **503 + `Retry-After: 30`**, never fail-open. A timed-out hit that lands later is given back. `releaseWithin` (`:120-131`) is best-effort: a slow or failed release leaves the hit counted (the safe direction). Sign-in makes two sequential checks, so its worst case is about 2 s (`:25`).

### 1.5 Recovery today

- The lock lifts at the end of the fixed window (at most 15 min after the first counted failure), **if** the attacker stops.
- A successful sign-in releases only its **own** reservation. Earlier failures stay counted until the window ends.
- `confirmPasswordReset` (`auth.service.ts:565`) does **not** touch the rate-limit counters. A user who resets their password while locked is still locked until the window ends.
- No support or admin action clears a lock.

---

## 2. Threat analysis of today's design

### 2.1 Single-IP attacker locks out the owner, who signs in from another IP

**Exploitable, indefinitely, from one IP.** The attacker sends 5 wrong passwords for the owner's email at the start of each 15-minute window. The 6th attempt from anyone, including the owner from their own IP with the correct password, gets 429 until the window ends; then the attacker sends 5 more. That is 20 requests per hour, under `signin_ip`'s 30 per hour, so the attacker is never throttled. Knowing the email is enough; no password knowledge is needed.

### 2.2 Distributed guessing

The account bucket caps guessing at **5 per 15 min = 480 per day** per account no matter how many IPs are used. This is today's strong property, and any redesign trades some of it away.

### 2.3 Privacy and non-disclosure

Sound for enumeration (§1.3). The weakness is storage: Redis keys hold raw emails (PII) and IPs. See §7.

### 2.4 RT-136

Correct: a success never counts, and neither does any non-credential error.

### 2.5 `TRUST_PROXY` (RT-624)

`resolveTrustProxySetting` (`common/trust-proxy.ts`) maps an unset value to `false`. Behind Caddy every client then has the proxy's IP, so `signin_ip` becomes **one global 30-per-hour budget for every user**. RT-624 only logs a warning at boot unless `TRUST_PROXY_REQUIRED=true`. This does not affect today's account lockout, but it decides whether any IP-keyed redesign works at all (§3.3).

---

## 3. The candidate: (email, IP) 5 / 15 min + email-only 20 / 15 min

### 3.1 Shape

- **Pair bucket** `signin_pair`, keyed by (email, client IP): 5 per 15 min, failure-only (RT-136).
- **Email-only bucket** `signin_account`, keyed by email: 20 per 15 min, failure-only (RT-136).
- **Per-IP bucket** `signin_ip`: unchanged, 30 per hour, counts every attempt.

### 3.2 Against the owner's questions

| Question | Result |
|---|---|
| Single-IP attacker locks out the owner on another IP | **Fixed**, if §4.2 holds. The attacker exhausts only its own pair bucket, so the email-only bucket rises by 5 per window, which is below 20. |
| Distributed lockout | **Not fixed.** 4 IPs × 5 failures = 20 lock the email out on **every** IP, including the owner's. 4 IPs is cheap (a phone plus three VPN exits, or one IPv6 host unless §4.4 applies). The lockout lever moves from 1 IP to 4. |
| Distributed guessing | Still capped, but **4× looser**: 20 per 15 min = **1,920 per day** per account, against 480 today. A single IP stays at 5 per 15 min = 480 per day. |
| Non-disclosure | Preserved. Neither key depends on whether the account exists, and every refusal is the same 429. |
| Does the pair key leak anything? | No new enumeration. One weak side channel: an attacker whose pair count is below 5 but who gets 429 learns that **someone else** failed against this email recently. That reveals activity, not existence: unknown emails fill up the same way. It is the same signal today's email-only lock already gives. |
| Recovery for the real user | Better against one IP: the owner is never locked out by a stranger's single IP. Unchanged against 4+ IPs: wait out the window, unless D2 (reset clears) is approved. |
| RT-136 | Safe only if both failure-only buckets follow the same release rules (§4.3). |

### 3.3 How the IP is resolved decides whether the pair key helps

| Deployment | Effect on the candidate |
|---|---|
| `TRUST_PROXY` = correct hop count (1 behind one Caddy) | Works as designed. |
| `TRUST_PROXY` unset or `false` behind a proxy | Every client has the proxy IP, so the pair key is the email key: **the same as today**. Also `signin_ip` is global (§2.5). No regression, no benefit. |
| `TRUST_PROXY=true` | Express trusts the left-most `X-Forwarded-For`, which the client chooses. An attacker rotates it per request and gets a **fresh pair bucket every time**. Only the email-only cap of 20 binds, and `signin_ip` is bypassed too. |
| IPv6 | One host normally holds a whole /64 (2^64 addresses). Without prefix keying a single IPv6 host is an unlimited distributed attacker: it locks the account in 4 requests from 4 addresses and bypasses `signin_ip`. |
| IPv4-mapped IPv6 (`::ffff:a.b.c.d`) | Must be normalized to the IPv4 form, or one client gets two keys. |
| Shared IP (office NAT, carrier-grade NAT, the shop's own uplink) | An attacker behind the owner's IP shares the owner's pair bucket. No worse than today. |

---

## 4. Implementation rules the candidate depends on

These rules are what make §3.2's "single-IP is fixed" true. Each one has a test in §6.

### 4.1 Release rules (RT-136, extended)

Both failure-only buckets (pair and email-only) are released on success and on any error other than `UnauthorizedException`, exactly like `signin_account` today. `signin_ip` is never released.

### 4.2 Check order: a refusal must not spend another bucket

The single-IP fix fails if one refusal costs the email-only bucket a hit. If the email-only bucket were reserved first and not released when the pair bucket refuses, one IP would push the email-only count up by 1 per request and reach 20 within the window: a global lockout from one IP again.

Rule: **reserve in the order pair → email-only → IP, and when any bucket refuses, release every reservation taken earlier in the same request.** The pair bucket's own over-limit hit stays counted, as `signin_account`'s does today. That is harmless: it only extends nothing (§1.2) and only affects the attacker's own pair.

Why pair first: a locked pair answers 429 without touching the email-only or IP budgets, so an attacker hammering its own locked pair does not spend the owner's shared budget.

### 4.3 Errors after reservation

A 503 from the limiter, a 503 from the identity provider, or a 500 releases both failure-only reservations, as today.

### 4.4 Keying

- IPv4: the full address. IPv6: the **/64 prefix**, for both the pair bucket and `signin_ip`. IPv4-mapped IPv6 normalized to IPv4.
- The pair identifier must be unambiguous. `email + ":" + ip` is ambiguous because IPv6 contains `:`. Use a length-prefixed or hashed form (§7 fixes this as a side effect).

### 4.5 Redis outage

A third sequential limiter call raises the worst-case 503 latency from about 2 s to about **3 s** at the default 1 s timeout. That is acceptable for a fail-closed route; the implementation must update the "two sequential checks" note at `public-auth-limiter.ts:25`. A timed-out reservation must be given back the same way `checkWithin` does today, for each of the three buckets.

---

## 5. Options compared and recommendation

### 5.1 Options

| | Option | Single-IP lockout | Distributed lockout cost | Guesses per account per day (distributed) | Contract or UX change |
|---|---|---|---|---|---|
| 0 | Today: email 5 / 15 min | **1 IP, forever** | 1 IP | 480 | none |
| **A** | **Candidate: pair 5 / 15 min + email 20 / 15 min** | **fixed** | **4 IPs** | **1,920** | none |
| A′ | Pair 5 / 15 min + email 50 / 15 min | fixed | 10 IPs | 4,800 | none |
| B | A + trusted-device cookie: a browser that signed in successfully before is exempt from the email-only cap (OWASP "device cookies") | fixed | **not possible against a returning device** | 1,920 from new devices | new cookie: auth contract change, `[GATED]` |
| C | Pair 5 / 15 min + email-only 100 / 24 h | fixed | 20 IPs, but then **locked for up to 24 h** | 100 | none |
| D | Today + progressive delay instead of a hard lock | delayed, not locked | n/a | depends on the delay curve | a held connection per attempt: worse under load, conflicts with the bounded-latency posture of RT-628 |

Notes:

- **A′** buys a higher lockout cost (10 IPs) with a 2.5× larger guess budget than A. With IPv6 /64 keying in place, 4 and 10 IPs are both cheap for a determined attacker, so A′ does not change the class of attacker that can lock the owner out; it mostly gives away guesses.
- **C** has the lowest guess budget (it meets the NIST SP 800-63B §5.2.2 ceiling of 100 consecutive failures per account), but a successful distributed attack locks the owner out for up to a day. For a pilot with a handful of owners, a day-long lockout is a worse failure than 1,920 online guesses against a password that must be at least 12 characters (`dto.ts:63`).
- **B** is the only option that breaks the distributed lockout for a returning user. It needs a new cookie and contract text, so it is not a drop-in change and is out of scope for O9.
- **D** is rejected.

### 5.2 Recommendation

**Approve option A with pair 5 / 15 min and email-only 20 / 15 min.** Reasons:

1. It closes the cheapest attack there is today: a permanent lockout from one IP at 20 requests per hour.
2. It keeps every property RT-136 and FR-ISO-4 rely on: failures only, same 401, same 429, no enumeration.
3. Its cost, 1,920 instead of 480 guesses per day across many IPs, is acceptable for 12-character minimum passwords. It is a real loosening and the owner should accept it knowingly.
4. It needs no contract change and fits the existing `RateLimiter` primitive.

The recommendation holds **only together with these preconditions**, which belong in the implementation issue's acceptance criteria:

| # | Precondition | Why |
|---|---|---|
| P1 | Check order and release rules of §4.1-§4.3. | Without them, one IP can still lock the owner out (§4.2). |
| P2 | IPv6 /64 keying and IPv4-mapped normalization (§4.4) for the pair bucket and `signin_ip`. | Without it, one IPv6 host is an unlimited distributed attacker. |
| P3 | Deployed `TRUST_PROXY` is a **hop count**, never `true`; the owner decides (D3) whether `TRUST_PROXY_REQUIRED=true` is set in staging, pilot and prod so a misconfiguration fails at boot. | `true` lets the client pick its own IP (§3.3). Unset makes the redesign a no-op. |
| P4 | A successful password-reset confirm clears that email's pair and email-only sign-in counters (owner decision D2). | Gives the real user a recovery path that does not depend on the attacker stopping. The reset token is the proof, so this hands an attacker nothing. |
| P5 | Redis outage behaviour unchanged (fail closed, 503, about 3 s worst case); the `public-auth-limiter.ts` header is updated. | RT-628 / O6. |

### 5.3 Next step if a distributed lockout is ever seen

Option B (trusted-device cookie). It is the only measure that keeps a returning owner signed in under a multi-IP attack. It needs its own contract-first issue.

### 5.4 Out of scope

- Users linked to the identity provider: the provider may apply its own lockout after Backend-Core admits the attempt. This review covers Backend-Core's limits only.
- `signin_ip` counts successful sign-ins too. Behind a shared IP (a shop's uplink) many staff signing in can exhaust 30 per hour. That is not changed by O9; it is noted for RT-624 follow-up.

---

## 6. Tests the implementation must pass

Unit tests extend `apps/api/test/auth/auth.controller.unit.spec.ts` (the `RecordingRateLimiter` already records `calledBuckets` and `releasedBuckets`). Real-counter tests use the in-memory fake (`rate-limit.spec.ts`) or real Redis (`rate-limit.real-redis.spec.ts`).

**Single IP cannot lock out another IP**
1. Five failures for email E from IP X; the sixth from X gets 429. A correct-password sign-in for E from IP Y then succeeds with 200.
2. Twenty more requests for E from X (all 429 on the pair bucket) leave the email-only count for E unchanged. A sign-in for E from Y still succeeds.
3. Check order: `calledBuckets` is `[signin_pair, signin_account, signin_ip]`. A locked pair stops at `[signin_pair]`.

**Distributed guessing is still capped**
4. Four IPs × 5 failures for E: the next attempt from a fifth IP, with the correct password, gets 429 (the email-only cap). This test records the accepted residual risk.
5. Fixed window: after the window ends, a correct sign-in succeeds; over-limit hits during the window do not extend it.

**RT-136 regression**
6. Success releases both failure-only reservations; `signin_ip` is not released.
7. A 401 keeps both failure-only reservations.
8. An email-only refusal releases the pair reservation. A `signin_ip` refusal releases both. A provider 503, a limiter 503 and a 500 release both.
9. The existing RT-136 tests (`auth.controller.unit.spec.ts:421-450`) keep passing with the bucket names updated.

**Non-disclosure**
10. For an unknown email and a known email, the 401 bodies are identical, and the 429 bodies and `Retry-After` behaviour are identical at the same counts.
11. The unknown-email path still runs `verifyPassword` against `DUMMY_PHC` (existing coverage stays green).

**Keying**
12. Two IPv6 addresses in the same /64 share one pair bucket and one `signin_ip` bucket; addresses in different /64s do not.
13. `::ffff:203.0.113.5` and `203.0.113.5` share a bucket.
14. `E` and ` e ` (case and whitespace) share a bucket (the `Email` schema already guarantees this; the test pins it).
15. No two (email, IP) pairs can produce the same key (the IPv6 colon ambiguity, §4.4).

**Recovery (if D2 is approved)**
16. With E locked on both buckets, a successful reset confirm for E clears them; the next correct sign-in from the locked IP succeeds.
17. A failed or expired reset confirm clears nothing.

**Redis outage (RT-628)**
18. A timeout on each of the three buckets answers 503 + `Retry-After: 30` and releases the reservations taken before it. `public-auth-redis-outage.http.spec.ts` is extended to the new bucket.

**`TRUST_PROXY`**
19. Behind one proxy with `TRUST_PROXY=1`, a client-supplied extra `X-Forwarded-For` hop does not change the pair key.

**Observability**
20. A 429 on the pair bucket emits `auth_failure_total{cause="rate_limited"}` and `suspicious_login_total{reason="rapid_retry"}`, like the two existing sign-in buckets (`SIGNIN_RATE_LIMIT_BUCKETS`, `auth.controller.ts:87-90`), and no log line holds an email or IP.

---

## 7. Follow-up: PII in Redis keys

Today Redis holds `rl:signin_account:<email>` and `rl:signin_ip:<ip>`; the candidate adds a key that holds both. Anyone who can run `KEYS`/`SCAN` on Redis, or who reads a Redis snapshot, gets a list of the emails that tried to sign in recently, failed attempts included.

Proposal (owner decision D4: open it, and whether before or with RT-625): derive every public-auth identifier as an **HMAC-SHA-256 of the normalized email and/or IP prefix under a server secret**. This:

- removes the raw email and IP from Redis;
- makes the pair identifier unambiguous (fixes §4.4's colon problem);
- leaves the counters unchanged, so no behaviour changes.

It needs a new secret in the deployment configuration, so it is its own issue. Changing the key derivation resets all counters once at deploy; that is acceptable.

---

## 8. Owner decisions

| # | Decision | Recommendation |
|---|---|---|
| **D1** | O9 numbers | Option A: pair 5 / 15 min, email-only 20 / 15 min, `signin_ip` unchanged at 30 / h, with preconditions P1-P5. |
| **D2** | A successful password reset clears the sign-in counters for that email | Yes. |
| **D3** | `TRUST_PROXY_REQUIRED=true` in staging, pilot and prod before RT-625 ships | Yes. Otherwise the redesign silently does nothing behind Caddy. |
| **D4** | Open the HMAC-keys follow-up (§7) | Yes, as its own issue; it can ship before or after RT-625. |
