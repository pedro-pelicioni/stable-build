# find-idea: interview, rubric, example

## Questions (ask at most 5, in one message)

Skip any question the user has already answered. If the user wants to skip them all, use the defaults and say so in the "Assumed" line of the output.

| # | Ask | Why it matters | Default if unanswered |
|---|---|---|---|
| 1 | What do you build with? (TypeScript/React, backend, Solidity, agents and LLM tooling, little code) | Picks SDK-first ideas (App Kits, Gateway, Agent Stack) or contract-first ideas | TypeScript full-stack, light Solidity |
| 2 | How much time until it must work? (a weekend, about two weeks, one to three months) | Sets scope; checks whether a program deadline is reachable | About two weeks, part-time |
| 3 | Who are the users, and where? (for example freelancers in Brazil, exporters in Kenya, AI agents, households) | Grounds the idea in a real payer and payee; local context is an edge in frontier 1 | Small businesses that pay people in two or more countries |
| 4 | Which RFB frontier pulls you, if any? And how will users sign: browser wallet (EOA), embedded Circle Wallets, passkey smart accounts, or agents? | Frontier focus; the wallet model decides whether Memo and Multicall3From (EOA only) can be used | No frontier preference; browser wallet (EOA) |
| 5 | What is the goal: a hackathon demo, live on Arc mainnet soon (needed for Microgrants), or a company? | Mainnet goals exclude testnet-only, permissioned and roadmap blocks; company goals bring in Developer Grants and the Builders Fund | Testnet prototype first; mainnet if a program deadline fits |

## How answers become constraints

| Answer | Constraint |
|---|---|
| Smart accounts or passkeys | No idea may require Memo or Multicall3From from the user's account. They revert when the caller is not an EOA (https://docs.arc.io/arc/concepts/transaction-memos). Use a server-side EOA, or a different design. |
| Little or no Solidity | Prefer App Kits, Gateway, Nanopayments, Agent Stack and Circle Wallets. Use contracts only from audited templates or sample apps. |
| A weekend | Keep only ideas where a starter or sample app already covers most of the work. |
| Mainnet soon | Required blocks must be `live`. Check that the deadline in `programs.json` leaves time for a mainnet deploy, and recommend running `stable-build:go-live` before it. |
| A region | Prefer local-market ideas for it. Whether App Kit Onramp covers that country is not in the data (UNVERIFIED): tell the user to check https://docs.arc.io/app-kit/onramp. |
| Company | Mention Developer Grants (teams already shipping) and the Builders Fund (deck submission) as possible fits, never as promises. |

## Scoring rubric (each 1 to 5, total out of 35)

| Criterion | 5 | 3 | 1 |
|---|---|---|---|
| Frontier fit | One RFB opportunity, named | Next to an opportunity | No frontier link |
| Block readiness | Every required block `live` | One optional block is `permissioned` or `testnet-only` | Never score: drop the idea if a required block is not `live` |
| Builder fit | Matches the stated skills | Needs one new skill | Needs several new skills |
| Time to first demo | A starter or sample app covers most of it | Partial reuse | From scratch |
| Program fit | An open program fits, with a reachable deadline | A program fits but the deadline is tight | None open |
| Overlap | None found | Adjacent, with a clear difference | Direct and active |
| User clarity | A named user, place and pain | A named user only | Vague |

Tie-breakers, in order: a shorter path to a mainnet deploy; fewer regulated surfaces (custody of other people's funds, credit, insurance, investment products).

Drop an idea when:

- a required block is `roadmap` or not documented;
- it depends on App Kit Earn or USYC;
- it needs private onchain data today (Arc Privacy is roadmap);
- it needs a program that has already closed.

## Worked example (shape only, not data)

Profile: TypeScript developer, about 10 days part-time, freelancers paid by agencies in Brazil, frontier 1, browser wallet, wants mainnet for Microgrants.

Candidate: "Agency payouts with receipts". An agency uploads a CSV and pays its freelancers in USDC. Each payment carries an opaque memo reference, and freelancers get a link to a receipt page.

- Frontier 1 / Borderless payroll. Blocks: usdc (live), memo (live), multicall3from (live).
- Closest: the payouts starter (`stable-build:new-app`).
- Overlap: check `ecosystem.json` Payments/Fintechs entries and `gh search repos "payroll usdc arc"`. Say how the receipts differ.
- Program: Microgrants, if it is open in `programs.json` and a mainnet deploy fits in the time left.
- Score: frontier 5, blocks 5, builder 5, time 5, program 4, overlap 3, user 5, for 32/35.

Write the real output with the template in `../SKILL.md`, and take every date, deadline and status from the data files or from docs checked today. Never copy them from this example.
