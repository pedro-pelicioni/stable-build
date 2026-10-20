# stable-build onboarding

[Read in English](README.md)

Cliente de referência para `register()` no `GoLiveRegistry`. É um app em React, Vite e viem. O stable-build é um projeto da comunidade e não tem afiliação com a Circle.

## Por que esta pasta

`apps/onboarding` fica ao lado do contrato e do assinador. O starter `new-app` é `payouts`, e o `scaffold.mjs` copia esse starter para outros projetos. Este cliente chama o `GoLiveRegistry`, lê o JSON do `go-live-sign.mjs` e segue o `studio-ui-prompt.md`. Não é um segundo starter.

## O que ele faz

A página é um chat escuro. Um roteiro fixo roda sem modelo e sem chave. Você conecta uma carteira injetada EIP-1193, troca para a chain Arc configurada e lê o saldo de USDC no ERC-20 em `0x3600…0000` (6 decimais). A visão nativa desse saldo usa 18 decimais e não entra nessa conta.

`+` carrega o payload assinado. O app lê `fee()` no registro e para com `FeeMismatch` quando a taxa assinada é diferente. Em seguida roda `eth_call` e `estimateGas`. Você assina `approve` pela taxa exata e depois `register`. As duas transações usam value `0`. `maxFeePerGas` fica em pelo menos 20 gwei. A linha de evento aponta a transação, e o app lê `badgeOf` de volta.

Na chain id 5042 o app pede para digitar `SEND REAL USDC` e definir um teto de taxa antes de qualquer transação. `VITE_NETWORK=mainnet` mantém essa trava mesmo quando `VITE_RPC_URL` aponta para um fork local.

Endereço do USDC, decimais e chain ids: [endereços de contrato](https://docs.arc.io/arc/references/contract-addresses), [diferenças do EVM](https://docs.arc.io/arc/references/evm-differences), [conectar à Arc](https://docs.arc.io/arc/references/connect-to-arc). Hosts de RPC e explorer: [endpoints de RPC](https://docs.arc.io/arc/references/rpc-endpoints).

## Rodar localmente na testnet

Node 22.12 ou mais novo. Uma carteira injetada (MetaMask, Rabby ou outra carteira EIP-1193). Na raiz do repositório:

```sh
cd apps/onboarding && npm ci && npm test && npm run dev
```

O servidor de desenvolvimento escuta em `http://localhost:5173`. Copie `.env.example` para `.env` e defina `VITE_REGISTRY_ADDRESS` com o registro da testnet. Deixe `VITE_NETWORK` como `testnet` (chain 5042002, `https://rpc.testnet.arc.io`).

Assine um payload na sua máquina. A chave fica em `STABLE_BUILD_VERIFIER_KEY` e nunca num nome `VITE_*`. Na raiz do repositório, com endereços seus:

```sh
node tools/go-live-sign.mjs \
  --report docs/go-live-report.md \
  --project 0xProject \
  --registry 0xRegistry \
  --chain-id 5042002 \
  --expiry 1893456000 \
  --nonce 1 \
  --fee 10000
```

Troque `0xProject` e `0xRegistry` antes de rodar. `10000` é 0,01 USDC em unidades de 6 decimais. Anexe o JSON impresso com `+`. USDC de testnet está em https://faucet.circle.com.

## Rodar localmente num fork de mainnet com `arc-anvil`

Isto faz fork do estado público da mainnet. Não envia transação. A chain id continua 5042, então a frase digitada continua valendo.

```sh
arc-anvil --network arc --fork-url https://rpc.mainnet.arc.io --port 8545
```

Em outro shell, a partir de `apps/onboarding`:

```sh
VITE_NETWORK=mainnet VITE_RPC_URL=http://127.0.0.1:8545 VITE_REGISTRY_ADDRESS=0xRegistry npm run dev
```

Assine o payload com `--chain-id 5042` e o mesmo endereço de registro. A frase é `SEND REAL USDC`. O host do explorer dessa rede é `https://explorer.arc.io` (testnet: `https://explorer.testnet.arc.io`).

## Ambiente

| Nome | Onde | Significado |
|---|---|---|
| `VITE_NETWORK` | bundle do navegador | `testnet` (padrão) ou `mainnet` |
| `VITE_RPC_URL` | bundle do navegador | RPC opcional; vazio usa o endpoint público |
| `VITE_REGISTRY_ADDRESS` | bundle do navegador | `GoLiveRegistry` dessa rede |
| `VITE_CHAT_ENABLED` | bundle do navegador | `true` chama `/api/chat`; qualquer outro valor mantém o roteiro |
| `LLM_PROVIDER` | servidor | `openai` ou `anthropic` |
| `LLM_BASE_URL` | servidor | opcional; o padrão é a API pública do provedor |
| `LLM_API_KEY` | servidor | chave do modelo; nunca um nome `VITE_*` |
| `LLM_MODEL` | servidor | obrigatório quando o chat está ligado; nenhum modelo está fixo no código |
| `ARC_RPC_URL` | servidor | RPC opcional para `/api/chat`; o cliente não pode defini-lo |

`vite dev` e `vite build` encerram quando um valor `VITE_*` parece uma chave de 32 bytes.

## API de chat opcional

`/api/chat` é um handler Node para a Vercel (`api/chat.ts`). O `vite dev` monta o mesmo caminho. As tools são `get_balance`, `explain_step`, `simulate_tx`, `build_approve_tx`, `build_register_tx` e `get_registry_badge`. Elas leem ou preparam. Não assinam e não aceitam calldata vinda do modelo. A página mostra Sign só quando a proposta coincide com a transação que ela montou localmente. Sem `LLM_API_KEY` ou `LLM_MODEL`, a resposta é 503 com `fallback: true`, e a página usa o roteiro.

`LLM_PROVIDER=openai` usa chat completions. `LLM_PROVIDER=anthropic` usa a Messages API. Defina `LLM_BASE_URL` para outro host que fale a API do provedor escolhido. A chave fica no ambiente do servidor.

O `vercel.json` desta pasta faz o build do app Vite. Aponte o projeto da Vercel para `apps/onboarding`. Não altere o `vercel.json` da raiz do repositório: esse arquivo serve `site/`. Este repositório não faz deploy deste app.

## Testes

```sh
cd apps/onboarding && npm test
```

O Vitest cobre taxa divergente, chain errada, 6 contra 18 decimais, checagens do payload (digest, assinatura, value `0`) e a frase e o teto na mainnet. O job de CI `onboarding` roda `npm ci`, `npm test`, `npm run build` e `guard.mjs --scan`.

## Arc Studio

Quem mantém o projeto regenera a UI no Arc Studio a partir de [`studio-ui-prompt.md`](studio-ui-prompt.md). O Studio faz deploy de contratos só na testnet ([Arc Studio CLI](https://docs.arc.io/ai/arc-studio-cli)). Esta pasta é o cliente de referência do mesmo fluxo: carteira, `approve`, `register`, link do explorer, `badgeOf`. Cole o prompt no Studio você mesmo. Este agente não abriu o Arc Studio.

## O que este app não faz

Ele não guarda chave de verificador, não assina payload e não envia transação. Não envia value nativo. Não lê `getBalance`. Não mistura quantias ERC-20 de 6 decimais com quantias nativas de 18 decimais.

## UNVERIFIED

A página foi aberta num navegador no build padrão de testnet. Foram conferidos uma sessão nova, uma resposta do roteiro, um arquivo JSON inválido, um payload assinado sem carteira, a mensagem de carteira ausente e a pílula de mensagens novas. Em 390px a barra lateral fica acima do chat. Com `VITE_NETWORK=mainnet` o selo é Mainnet com contorno vermelho. Nada nessa passagem assinou ou enviou transação.

- Nenhuma extensão de carteira foi usada, então conectar, trocar de rede, approve e register não foram clicados numa chain ao vivo.
- Nenhuma transação foi enviada, nem na testnet nem na mainnet.
- `/api/chat` não foi chamado contra um modelo ao vivo.
- `arc-anvil` não foi iniciado nesta mudança.
- O Arc Studio não foi aberto, e o prompt não foi colado lá.
