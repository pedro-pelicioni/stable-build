<!-- Adapted from BMad Method v6.12.1 src/core-skills/bmad-brainstorming/assets/brain-methods.csv (trimmed to 30 techniques and reworded) (https://github.com/bmad-code-org/BMAD-METHOD, commit 790dae9c). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# Brainstorming techniques

A trimmed set for solo builders and small teams. A batch of 3-4 is the sweet spot; mix categories so the creative domain shifts. Good-for tags: **novel** (new ideas), **feature**, **strategy**, **diagnosis** (find the real problem), **unstuck**, **planning**.

## Framing the problem
| Technique | How | Good for |
| --- | --- | --- |
| How Might We | Rewrite the problem as a batch of "How might we…" questions, then ideate against the sharpest one. | feature, strategy |
| Job to Be Done | Ask what the user is really hiring this for; ideate around that job, not the feature you assumed. | feature, strategy |
| Empathy Map | Map what the user says, thinks, does and feels; mine each quadrant for the unmet need. | feature |
| Question Storming | Only questions, no answers, until the problem worth solving comes into focus. | diagnosis, unstuck |
| Five Whys | Ask "why?" five times in a chain to reach the root cause. | diagnosis |
| Laddering | Ask "and what would that give you?" until you reach the underlying need, then ideate there. | strategy, diagnosis |

## Breaking assumptions
| Technique | How | Good for |
| --- | --- | --- |
| First Principles | Strip every assumption to bedrock facts and rebuild from those alone. | novel, feature |
| Assumption Reversal | List the assumptions baked into the problem, flip each, and build on the inverted base. | novel, strategy |
| What If Scenarios | Remove one constraint at a time (unlimited budget, the opposite is true) and chase what rushes in. | novel, unstuck |
| Constraint Mapping | Map every constraint, sort real from imagined, then dissolve, route around, or exploit each. | feature, strategy |
| TRIZ Contradiction | Name what only improves by making something else worse, then find ways to win both. | feature, novel |

## Borrowing from elsewhere
| Technique | How | Good for |
| --- | --- | --- |
| Analogical Thinking | Ask "this is like what?" and take the solution pattern from the domain that answers. | feature, novel |
| Cross-Pollination | Ask how a distant industry (an ER, a casino, a beekeeper) would crack it, then adapt the move. | novel, strategy |
| Trait Transfer | Name what makes an unrelated success work and graft those traits onto your problem. | novel, feature |
| Persona Journey | Solve it in character as an archetype and name what that persona sees that you miss. | feature, strategy |
| Alien Anthropologist | Narrate the problem as a baffled outsider; note what seems arbitrary. | diagnosis, unstuck |

## Structured generation
| Technique | How | Good for |
| --- | --- | --- |
| SCAMPER | Substitute, combine, adapt, modify, put to other use, eliminate, reverse. | feature, novel |
| Morphological Analysis | List the independent parameters, options for each, then combine across them. | feature, planning |
| Starbursting | Interrogate the idea with who, what, where, when, why, how before answering any. | feature, planning |
| Crazy 8s | Eight ideas in eight minutes, no editing. | feature, unstuck |
| Disney Method | Dreamer (anything goes), Realist (how we'd build it), Critic (what breaks), in turn. | feature, strategy |
| Six Thinking Hats | Facts, feelings, benefits, risks, new ideas, process, one at a time. | strategy, diagnosis |

## Inversion and pressure
| Technique | How | Good for |
| --- | --- | --- |
| Reverse Brainstorming | "How could we make this fail?", then invert each answer. | diagnosis, feature |
| Worst Possible Idea | Generate terrible solutions on purpose, then flip each into a lesson. | unstuck, novel |
| Ship in 60 Minutes | You launch in an hour with what is on hand: what do you cut, fake or borrow? | feature, planning |
| One Feature Only | Keep exactly one capability and make it great. | feature, strategy |
| Kill the Crown Jewel | Delete the best-loved feature and redesign to win without it. | feature, unstuck |

## Futures
| Technique | How | Good for |
| --- | --- | --- |
| Backcasting | Describe the finished future in detail, then work backwards to the first move. | strategy, planning |
| Scenario Cross | Cross two big uncertainties into four futures; find the move that wins in all four. | strategy, planning |
| Artifact From the Future | Describe a news clip or receipt from the world where this already won, then reverse-engineer it. | novel, feature |

## Arc lenses (stable-build additions)
Prompts to fold into any technique when the idea is an app built on Arc. Check each capability against docs.arc.io before relying on it.
- **Final in a second:** what workflow today waits on settlement, and what changes if a payment is final after one confirmation? (https://docs.arc.io/arc/concepts/deterministic-finality)
- **Dollar-denominated gas:** fees are paid in USDC; who in your flow could pay them for the user? (https://docs.arc.io/integrate/wallets/fee-display)
- **Money with a reference:** what reconciliation pain disappears if every transfer carries an invoice or order id? (https://docs.arc.io/arc/concepts/transaction-memos)
- **Many payees, one action:** what process pays many people at once today, and how? (https://docs.arc.io/arc/concepts/batched-transactions)
- **Software that pays:** what would an agent or service pay for per request? (Request for Builders: https://www.arc.io/blog/the-unfinished-business-of-finance-machine-commerce-and-global-money)
