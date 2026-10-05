# {{APP_NAME}}

[Read in English](README.md)

Este app paga em USDC, na Arc, os destinatários de um CSV. Cada linha leva um
memo onchain, as linhas são agrupadas em poucas transações e cada uma é conferida
com o seu receipt. É um web app estático (carteira no navegador) mais uma CLI em
Node (chave local), sem backend e sem chaves de API.

Criado a partir do starter `payouts` do stable-build. O stable-build é um projeto
da comunidade, sem afiliação com a Circle.

> **Memos e valores ficam públicos para sempre.** Destinatários, valores e
> referências de memo podem ser lidos onchain por qualquer pessoa, para sempre.
> Use referências opacas, como `INV-0042`. Nunca coloque nomes, e-mails ou
> observações na coluna `reference` do CSV. É por isso que o parser recusa
> espaços e `@` nas referências.

## Início rápido (testnet)

Você precisa do Node 22.12 ou mais recente e de uma carteira EOA no navegador
(MetaMask, Rabby, Coinbase Wallet ou parecida).

```bash
npm install
npm test          # unit tests, including recorded Arc Testnet receipts
npm run dev       # http://localhost:5173
```

1. Pegue USDC de testnet em https://faucet.circle.com (Arc Testnet). O USDC
   também paga o gas.
2. Conecte sua carteira. O app adiciona a Arc Testnet (chain 5042002) se a
   carteira ainda não tiver essa rede.
3. Clique em **Load sample** ou envie um CSV e, depois, em **Simulate and plan**.
4. Clique em **Send pending rows**, confirme na carteira e acompanhe a
   conciliação de cada linha.
5. Exporte o ledger (CSV ou JSON). Importe o JSON depois para retomar um lote.

Pagar o mesmo arquivo duas vezes é evitado de duas formas. O navegador guarda um
ledger por arquivo, conta e rede, então enviar o mesmo arquivo de novo retoma o
lote. Se não houver ledger salvo (outro navegador, armazenamento limpo), o
planejamento lê antes o histórico de Memo da sua conta atrás das referências do
arquivo (os últimos 300.000 blocos, cerca de 40 horas com o tempo de bloco de
~0,48 s da testnet, 31 chamadas `eth_getLogs`): um arquivo já pago retoma o lote
e pula as linhas pagas, e um arquivo cujas referências foram pagas de outro jeito
é recusado. Pagamentos mais antigos que essa janela não aparecem, então guarde o
JSON do ledger exportado. Para uma nova rodada de pagamentos, use referências
novas.

Formato do CSV (`sample/payroll.csv`):

```csv
recipient,amount,reference
0x0Bcf6849b35cEA52FDfcCFD41166CE5dc4c51cE1,0.01,PAY-2026-10-001
```

- `recipient`: um endereço 0x. Endereços com maiúsculas e minúsculas misturadas
  precisam passar no checksum EIP-55. O endereço zero e os contratos USDC, Memo e
  Multicall3From são recusados.
- `amount`: USDC, maior que 0, com no máximo 6 casas decimais (a interface
  ERC-20).
- `reference`: única, de 1 a 64 caracteres entre `A-Z a-z 0-9 . _ : / # -`.

## CLI

```bash
npm run payout -- sample/payroll.csv --dry-run                  # plan only; no key
npm run payout -- sample/payroll.csv --dry-run --from 0xYourEOA # with eth_call simulation
export PAYOUT_PRIVATE_KEY=0x…                                   # testnet key, set in your shell only
npm run payout -- sample/payroll.csv                            # asks before sending
npm run payout -- sample/payroll.csv                            # rerun = resume; paid rows are skipped
```

- O ledger é gravado em `ledgers/<file>.<network>.json` a cada etapa, inclusive
  logo depois de cada broadcast. Se uma execução parar, rode o mesmo comando de
  novo para retomar. Sem arquivo de ledger, um lote novo confere antes o
  histórico de Memo atrás das referências do arquivo, como o web app
  (`--history-blocks <n>` muda a janela; `0` pula essa etapa).
- `--mode per-row` envia uma transação `Memo.memo` por linha, em vez de lotes.
- `--sync` atualiza o ledger a partir do histórico da chain e sai. Não precisa de
  chave: a conta vem do ledger, de `--from <address>` ou da chave. Sem arquivo de
  ledger, ele reconstrói um a partir do histórico de Memo, por referência, ou não
  grava nada.
- `--retry-rejected` devolve à fila as linhas rejeitadas na simulação; elas são
  simuladas de novo antes do envio.
- `--requeue-unknown` é a saída explícita quando uma transação enviada é
  desconhecida pelo RPC, o histórico de Memo não mostra as linhas dela como pagas
  e o nonce dela nunca foi registrado. Confira o explorer antes.
- A CLI se recusa a enviar quando `CI` está definida (`--dry-run` e `--sync`
  continuam funcionando). Ela se recusa a rodar quando uma variável `VITE_*` no
  shell ou num arquivo `.env*` contém algo com cara de chave privada; `vite dev`
  e `vite build` param pela mesma checagem.

## Mainnet

A testnet é o padrão em todo lugar.

- **Web app:** faça o build com `VITE_NETWORK=mainnet`. O app passa a mostrar um
  banner permanente de mainnet. Cada envio exige que você digite `SEND REAL USDC`
  e defina um teto por lote, em USDC, que cubra o lote. Os dois campos são limpos
  depois de cada envio e sempre que outro lote é planejado ou importado.
- **CLI:** `--network mainnet --cap <usdc>`, mais `--confirm "SEND REAL USDC"` ou
  digitar o texto no prompt.
- Antes de ir para a mainnet, rode o checklist `go-live` do stable-build e
  `npm run e2e:testnet` (veja abaixo).

## Como funciona

- **Uma chamada por linha.** Cada linha é
  `Memo.memo(USDC, transfer(recipient, amount), memoId, memoBytes)`. Um chunk de
  linhas é enviado como `Multicall3From.aggregate3(calls)` com
  `allowFailure: false`, numa única transação da EOA. Os dois contratos mantêm a
  sua carteira como `msg.sender`.
  Docs da Arc:
  [memos](https://docs.arc.io/arc/concepts/transaction-memos),
  [batches](https://docs.arc.io/arc/concepts/batched-transactions).
  A documentação não cobre o aninhamento dos dois. Isso foi conferido com
  receipts reais da testnet e com `eth_call` (`docs/batch-memo-evidence.md`).
- **Só EOA.** Memo e Multicall3From revertem para smart accounts e para carteiras
  multisig de contrato. O app checa `eth_getCode(account)` e recusa qualquer
  código, inclusive delegações EIP-7702 (`0xef0100…`), cujo comportamento aqui não
  foi verificado. Ele envia com `eth_sendTransaction`, nunca com
  `wallet_sendCalls`. Depois do envio, confere se `receipt.from` é a sua conta.
- **Schema de memo v1.**
  `memoId = keccak256(abi.encodePacked(bytes16 batchId, uint32 row))`, e o memo é
  um JSON curto (`docs/memo-schema.md`).
- **Chunks.** Os chunks começam com 50 linhas e são simulados antes com
  `eth_call`. Um chunk que reverte é simulado linha a linha, e as linhas que
  revertem sozinhas (destinatário inválido, endereço na blocklist) são marcadas
  como `rejected` e não são enviadas; **Re-queue rejected rows** (CLI:
  `--retry-rejected`) tenta de novo. Uma reversão por blocklist ainda custa gas
  onchain, então o app evita enviá-la
  ([EVM differences](https://docs.arc.io/arc/references/evm-differences)). Uma
  falha de RPC (HTTP 5xx, timeout, rate limit depois das novas tentativas) ou uma
  reversão por saldo nunca rejeita uma linha: a execução para e pode ser retomada.
  Um chunk é dividido ao meio se a estimativa de gas falhar ou passar da metade do
  limite de gas do bloco.
- **Taxas.** `maxFeePerGas = max(20 gwei, 2 × baseFee)`. A Arc descarta
  transações abaixo de 20 gwei sem receipt
  ([gas and fees](https://docs.arc.io/arc/references/gas-and-fees)). As taxas
  aparecem em USDC.
- **Saldo.** O preflight usa só `eth_getBalance` (18 decimais). O `balanceOf`
  ERC-20 do USDC é o mesmo dinheiro visto de outro jeito e nunca é somado por cima
  ([wallets](https://docs.arc.io/integrate/wallets)).
- **Conciliação.** Os logs entre `BeforeMemo(k)` e `Memo(k)` pertencem à linha k.
  Cada linha precisa ter um `Transfer` de 6 decimais vindo de `0x3600…` e um
  `Transfer` de 18 decimais vindo de `0xffff…fFfE`, ambos da sua conta, pareados
  por (from, to, value)
  ([USDC system events](https://docs.arc.io/arc/references/usdc-system-events)).
- **Histórico.** Os eventos Memo da sua conta são lidos com `eth_getLogs` em
  janelas de no máximo 9.999 blocos. Um erro `-32012` reduz a janela à metade;
  `-32014` e HTTP 429 fazem o app esperar e tentar de novo
  ([RPC endpoints](https://docs.arc.io/arc/references/rpc-endpoints)).
- **Retomada.** Linhas já pagas (identificadas pelo `memoId`) nunca são enviadas
  de novo.
- **Cancelar ou acelerar na carteira.** Se a carteira substituir uma transação, o
  app lê o receipt da substituta: as linhas que ela pagou são conciliadas com o
  novo hash; as que ela não pagou voltam para a fila e a execução para.
- **Nonces.** A CLI assina com o nonce pendente que leu e o registra antes do
  broadcast, para distinguir uma transação descartada de uma pendente. Carteiras
  de navegador escolhem o próprio nonce; o app pergunta ao RPC depois do
  broadcast. Uma transação que o RPC não conhece é procurada antes no histórico de
  Memo; se não estiver lá e o nonce for desconhecido, o app para e pede que você
  confira o explorer (**Re-queue unknown sends** / `--requeue-unknown`).
- **Ledger.** Os valores são guardados como strings de inteiros com 18 decimais
  (`amount18`). Cada linha registra status, hash da transação, bloco, log index,
  índice do memo e um link do explorer.
- **Polling.** O app consulta a cada 250 ms. A Arc produz cerca de 2 blocos por
  segundo, e a finalidade vem com uma única confirmação.

## Deploy no GitHub Pages

`.github/workflows/pages.yml` faz o build do site estático e o publica a cada
push na `main`. Para ativar, abra **Settings → Pages → Source** no seu repositório
e escolha "GitHub Actions". O workflow não usa segredos, porque quem assina é a
carteira do visitante. Nunca coloque uma chave numa variável `VITE_*`: esses
valores vão parar no bundle público.

## Checagem end-to-end (manual, só testnet)

```bash
STABLE_BUILD_E2E_KEY=0x…  npm run e2e:testnet
```

O script aborta se o RPC não informar o chain id 5042002 e se recusa a rodar em
CI. Ele envia 3 linhas de 0,01 USDC para endereços novos e depois confere:

- 3 eventos Memo e 3 pares de logs Transfer vindos da sua conta;
- se o ledger reconstruído a partir do histórico paginado bate;
- se uma nova execução não envia nada.

Use uma chave de testnet descartável, abastecida pelo faucet.

## Estrutura

```
src/config/   networks (chain ids, RPC, explorer, addresses), ABIs
src/core/     csv, memo-schema, plan, eoa-guard, logs, reconcile, ledger, run, chain
src/ui/       React UI, injected wallet, local storage
scripts/      payout.ts (CLI), e2e-testnet.ts (manual)
test/         vitest + recorded testnet fixtures
docs/         memo schema, composition evidence
```

## Limites conhecidos (UNVERIFIED)

- O tamanho ideal de chunk e os rate limits dos RPCs públicos não estão
  documentados. O RPC público da testnet respondeu a rajadas de `eth_getLogs` com
  HTTP 429 / `-32005` (visto em 2026-10-04); as leituras de histórico são
  espaçadas em 250 ms e repetidas em caso de falha. Use a URL de um provedor
  (`VITE_RPC_URL`, `--rpc`) para uso intenso.
- Contas delegadas via EIP-7702 são recusadas até que o comportamento delas com o
  Memo seja confirmado.
- O aninhamento lote + memo foi conferido na testnet, e na mainnet só com
  `eth_call`.

## Documentação

- Enviar USDC com um memo de transação: https://docs.arc.io/arc/tutorials/send-usdc-with-transaction-memo
- Enviar transferências de USDC em lote: https://docs.arc.io/arc/tutorials/batch-usdc-transfers
- Endereços de contratos: https://docs.arc.io/arc/references/contract-addresses
- Conectar à Arc: https://docs.arc.io/arc/references/connect-to-arc
