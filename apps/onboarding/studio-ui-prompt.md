# Prompt pro Arc Studio: app de onboarding do stable-build (layout de chat)

Cole no gerador de app do Arc Studio (ajuste o endereço do contrato depois do deploy).

---
Build a dark-theme chat-style web app called "stable-build onboarding" that guides a user from zero to their first on-chain `register()` on the GoLiveRegistry contract on Arc.

Layout (desktop first, responsive):
- Background near-black (#0b0b0c), panels #161618, large rounded corners (16-20px), subtle borders (#242427), system sans font.
- Left sidebar (~260px): top row with a search icon button and a "+" (new session) icon button; below, a list of onboarding sessions/projects. Each row: colored rounded avatar, bold name, one-line gray preview, and a small blue dot when there is an unread update. Selected row has a lighter background. Sidebar footer: user avatar (wallet identicon) and a pill button "Connect wallet" (shows short address + network badge when connected).
- Main area: header with the assistant name and a network badge (Testnet / Mainnet, red outline on Mainnet). A floating blue pill "N new messages ↑" appears when scrolled up.
- Messages: assistant bubbles on the left, dark gray (#1f1f22), rounded; user messages on the right as lighter pills (#2a2a2e). 
- Event lines: small centered gray text between messages for chain steps, e.g. "Wallet connected", "Network switched to Arc Mainnet", "Simulation passed (fee ~0.0005 USDC)", "Approve sent", "Registered ✓ view on explorer" with a link to https://explorer.arc.io/tx/<hash> (testnet: https://explorer.testnet.arc.io).
- Composer at the bottom: rounded input with a "+" button on the left (attach go-live report JSON / signed payload) and a round send button on the right.

Behavior:
- Steps: connect injected wallet (EIP-1193) → switch/add Arc chain (mainnet 5042, rpc https://rpc.mainnet.arc.io; testnet 5042002, rpc https://rpc.testnet.arc.io) → show USDC balance (ERC-20 at 0x3600000000000000000000000000000000000000, 6 decimals; never add it to the 18-decimal native balance) → load signed go-live payload → simulate with eth_call → approve exact fee → call register() → show event line with explorer link and the badge.
- Network chosen by env VITE_NETWORK (default testnet). On mainnet, require typing "SEND REAL USDC" before any tx and enforce a max fee cap.
- Never send native value; maxFeePerGas at least 20 gwei.
- Contract address from env VITE_REGISTRY_ADDRESS.
---

Observação: inspirado no estilo do Grok Bot, sem copiar nome, logo ou assets da marca.
