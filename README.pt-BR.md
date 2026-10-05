# stable-build

[Read in English](README.md) · Site: https://stable-build.vercel.app

Skills, um starter de pagamentos (payouts), um guard opcional que confere cada edição e um checklist de go-live para apps construídos na Arc, no **Claude Code** e no **Codex**. O kit acompanha quem constrói desde "o que eu construo?" até um relatório de prontidão para a mainnet:

```
find-idea -> new-app -> product-brief / pm / ux-designer / architect / stories -> dev -> gotchas / layered-review -> go-live
```

- **Projeto da comunidade, sem afiliação com a Circle.** Nada aqui sugere endosso da Circle ou da Arc. Os fatos sobre a Arc apontam para docs.arc.io ou developers.circle.com, e o que não conseguimos confirmar está marcado como UNVERIFIED.
- **As skills da própria Circle não vêm junto.** O instalador busca o plugin `circle-skills` da Circle em [circlefin/skills](https://github.com/circlefin/skills), e as skills do stable-build repassam a ele as perguntas sobre produtos da Circle.
- **Versão 0.1.0, ainda não lançada.** Testada com o Claude Code 2.1.280. A instalação pelo Codex foi montada a partir da documentação e do código-fonte do Codex e **ainda não foi testada** (veja [Status](#status-e-itens-unverified)).

## Instalação

Requisitos: Node.js 20 ou mais recente, mais o Claude Code 2.1.280 ou mais recente e/ou uma CLI do Codex que tenha `codex plugin`. O instalador precisa de bash 3.2 ou mais recente (o padrão do macOS serve).

### 1. Instalador (Claude Code e Codex)

```sh
curl -fsSL https://raw.githubusercontent.com/pedro-pelicioni/stable-build/main/install.sh | bash
```

Para ler o script antes, baixe-o e veja o plano:

```sh
curl -fsSLO https://raw.githubusercontent.com/pedro-pelicioni/stable-build/main/install.sh
bash install.sh --dry-run
bash install.sh
```

Ele pergunta antes de adicionar as skills da Circle, o plugin do Arc Studio e o guard. Rode-o num terminal comum, não dentro de uma sessão de agente. Rodar de novo é seguro: nada do que já está no lugar é alterado.

| Opção | Efeito |
|---|---|
| `--dry-run` | Mostra cada ação planejada e não altera nada |
| `--yes` | Responde sim a todas as perguntas, inclusive à de ligar o guard (um guard que você recusou antes continua desligado) |
| `--no-hooks` | Deixa o guard desligado e não pergunta, nem agora nem nas próximas execuções |
| `--no-mcp` | Pula o plugin `stable-build-mcp` |
| `--no-circle` | Pula o plugin de skills da Circle |
| `--no-studio` | Pula o plugin do Arc Studio |
| `--update` | Atualiza o stable-build e também os plugins da Circle e do Arc Studio, se foi este instalador que os adicionou. Nunca liga o guard |
| `--uninstall` | Remove só o que este instalador adicionou |
| `--ref=TAG` | Instala uma tag ou branch (padrão `main`, que só muda a cada release) |
| `--prefix=DIR` | Sandbox: toda chamada de CLI roda com `HOME=DIR`, então nada fora de `DIR` é gravado |
| `--lang=LANG` | Idioma do instalador e das respostas do kit, `en` ou `pt-BR`; fica salvo para as próximas execuções (veja [Idioma](#idioma)) |

Sem terminal conectado (ou dentro de uma sessão do Claude Code ou do Codex) e sem `--yes`, ninguém consegue responder às perguntas, então o instalador adiciona só o próprio stable-build: o plugin da Circle e o registro do Arc Studio ficam de fora (cada um precisa do seu sim, e instalar o plugin da Circle significa aceitar os termos de desenvolvedor da Circle), o guard continua desligado e o instalador explica como adicioná-los depois. Um "não" digitado na pergunta do guard fica registrado no manifesto, então as próximas execuções, mesmo com `--yes`, mantêm o guard desligado; para ligá-lo, use `/stable-build:gotchas enable`.

#### Idioma

O instalador, o aviso de uma linha do guard, o aviso de início de sessão e o que as skills escrevem para você (respostas no chat, `docs/go-live-report.md`, PRDs, stories, listas de ideias) saem em inglês ou em português do Brasil (`pt-BR`). A primeira pergunta do instalador é "Language / Idioma", e a resposta padrão vem de `LC_ALL`, `LC_MESSAGES` ou `LANG` (um valor que começa com `pt` escolhe português). Para responder de antemão:

```sh
bash install.sh --lang=pt-BR
curl -fsSL https://raw.githubusercontent.com/pedro-pelicioni/stable-build/main/install.sh | STABLE_BUILD_LANG=pt-BR bash
```

- `--lang` (ou `--lang pt-BR`, com espaço) tem prioridade sobre `STABLE_BUILD_LANG`, que tem prioridade sobre o idioma salvo numa execução anterior. Valores aceitos, com maiúsculas ou minúsculas: `en`, `english`, `pt`, `pt-BR`, `pt_BR`, `portugues`, `português`. Qualquer outro valor encerra o instalador com erro.
- Com `--yes`, sem terminal (uma sessão de agente conta como sem terminal) ou com `STABLE_BUILD_NO_TTY=1`, e sem idioma informado ou salvo, o instalador usa o padrão detectado sem perguntar.
- A escolha fica salva como `"language"` em `~/.stable-build/config.json` (as outras chaves desse arquivo são mantidas) e registrada no `manifest.json`. Novas execuções, `--update`, `--uninstall`, `--help` e as mensagens de erro reaproveitam esse valor; para mudar, rode de novo com `--lang`. O `--dry-run` não salva nada. Salvar o idioma não liga o guard: ele só roda quando esse arquivo contém `"guard": true`.
- Código, nomes de arquivo, ids de regra, flags de CLI e mensagens de commit continuam em inglês. As skills respondem no idioma salvo. Na conversa fora de uma skill, o agente só fica sabendo dele pelo aviso de início de sessão, que roda num projeto Arc com o guard ligado (`"guard": true`); ali, com `pt-BR` salvo, ele responde em português mesmo quando você escreve em inglês. Fora disso, e sem idioma salvo (por exemplo, depois de instalar com `/plugin` ou `codex plugin`), as respostas seguem o idioma em que você escreve.

### 2. Claude Code, com `/plugin`

```text
/plugin marketplace add circlefin/skills
/plugin install circle-skills@circle
/plugin marketplace add pedro-pelicioni/stable-build
/plugin install stable-build@stable-build
/plugin install stable-build-mcp@stable-build
/reload-plugins
```

O `stable-build-mcp` é opcional. Para ligar o guard, rode `/stable-build:gotchas enable`; a skill explica o guard e pergunta antes de gravar qualquer coisa. Comece por `/stable-build:guide`.

### 3. Codex, com `codex plugin` (UNVERIFIED: ainda não executado)

```sh
codex plugin marketplace add circlefin/skills --ref master
codex plugin add circle@circle-skills
codex plugin marketplace add pedro-pelicioni/stable-build --ref main
codex plugin add stable-build@stable-build
codex plugin add stable-build-mcp@stable-build
```

O `stable-build-mcp` é opcional; no Codex ele adiciona só o servidor de docs da Arc, porque o plugin da Circle para o Codex traz o seu. Se você ligar o guard, abra também `/hooks` no Codex e marque os hooks do stable-build como confiáveis: o Codex ignora hooks de plugin até você fazer isso.

## O que é alterado

Esta é a lista completa. O instalador em si só grava em `~/.stable-build`. Tudo o que muda nas pastas do Claude Code e do Codex é gravado pelos próprios comandos `claude plugin` e `codex plugin`; o instalador nunca edita `settings.json`, `.claude.json`, `config.toml` ou `hooks.json` à mão. O `--uninstall` desfaz só as entradas que registrou como `addedByUs`.

| Onde | Gravado por | O quê | Quando |
|---|---|---|---|
| `~/.stable-build/manifest.json` | instalador | O que ele adicionou, com `addedByUs` em cada entrada, versões, o commit de circlefin/skills, o idioma, se foi ele que criou o `config.json` e quando você recusou o guard | Sempre (não em instalações com `/plugin` ou `codex plugin`) |
| `~/.stable-build/config.json` | instalador ou a skill `gotchas` | `{"schemaVersion":1,"language":"en"}`, mais `"guard":true` e `"consentAt"` depois que o guard é ligado. Num arquivo que já existe, só essas chaves mudam | Instalação (o idioma); as chaves do guard só depois que você concorda em ligar o guard |
| `~/.claude/settings.json` | `claude plugin` | `extraKnownMarketplaces`: `stable-build`, e `circle` se tiver sido adicionado. `enabledPlugins`: `stable-build@stable-build`, `stable-build-mcp@stable-build`, e `circle-skills@circle` / `arc-studio@arc-studio-cli` se tiverem sido adicionados | Instalação |
| `~/.claude/plugins/` | `claude plugin` | `known_marketplaces.json`, `installed_plugins.json`, um clone de cada marketplace em `marketplaces/`, cópias dos plugins em `cache/<marketplace>/<plugin>/<version>/` | Instalação |
| `~/.claude.json` | Claude Code | O controle interno do próprio Claude Code, atualizado a cada execução da CLI | Qualquer chamada a `claude` |
| `~/.codex/config.toml` | `codex plugin` | `[marketplaces.stable-build]`, `[marketplaces.circle-skills]` se tiver sido adicionado, e as entradas de plugin (UNVERIFIED: tirado da documentação e do código-fonte do Codex) | Instalação |
| `~/.codex/plugins/` | `codex plugin` | Cópias dos plugins em `cache/<marketplace>/<plugin>/<version>/` e snapshots dos marketplaces (UNVERIFIED) | Instalação |
| Confiança nos hooks do Codex | Codex | Registrada quando você marca os hooks como confiáveis em `/hooks` | Só se você fizer isso |
| Plugin do Arc Studio | `arc-studio skills install --tool claude-code` | Marketplace `arc-studio-cli` (uma pasta dentro do pacote npm do Arc Studio) e plugin `arc-studio@arc-studio-cli` no Claude Code | Só se a CLI `arc-studio` estiver instalada, o plugin ainda não existir e você concordar |

Nunca alterados: perfis de shell, `PATH`, pacotes npm globais, regras de permissão (allow), outros plugins ou skills que você já tenha, qualquer login ou token, e os seus projetos. As skills só gravam num projeto quando você pede: `new-app` gera o starter numa pasta vazia que você indicar, as skills de planejamento gravam `docs/plan/` e `docs/stories/`, e `go-live` grava `docs/go-live-report.md`.

Uso de rede na instalação: as CLIs de plugin clonam `pedro-pelicioni/stable-build` e `circlefin/skills` do GitHub, e o instalador pode rodar `git ls-remote` em circlefin/skills para registrar o commit. Para evitar ferramentas MCP duplicadas, ele roda `claude mcp get arc-docs` e `claude mcp get circle` (e `codex mcp get arc-docs`); se você já tiver um servidor com um desses nomes, esse comando se conecta a ele. Depois de instalar o `stable-build-mcp`, ele confere só os dois servidores do plugin, com `claude mcp get plugin:stable-build-mcp:arc-docs` e `…:circle-codegen`, que se conectam a `https://docs.arc.io/mcp` e `https://api.circle.com/v1/codegen/mcp`. Ele nunca roda `claude mcp list`, que iniciaria todos os servidores MCP configurados na sua máquina. Tudo o que já existia antes de o instalador rodar (por exemplo, o marketplace da Circle ou um servidor MCP `arc-docs` no escopo de usuário) é registrado como não sendo nosso e é mantido na desinstalação.

## Skills

No Claude Code, rode uma skill como `/stable-build:<name>`, ou descreva a tarefa e o agente escolhe a skill. No Codex, peça a skill pelo nome (como o Codex mostra skills de plugin é UNVERIFIED). A lista abaixo é a mesma de [`skills/guide/references/catalog.md`](plugins/stable-build/skills/guide/references/catalog.md), que é gerado a partir do frontmatter das skills.

| Skill | O que faz |
|---|---|
| `guide` | Comece por aqui. Confere o ambiente sem alterar nada (plugin da Circle, Arc Studio, guard, Arc Foundry), pergunta em que etapa você está e indica a próxima skill. Encaminha perguntas sobre produtos da Circle para as skills da Circle e aponta onde o `use-arc` da Circle diverge de docs.arc.io. |
| `find-idea` | Uma entrevista curta e, depois, 5 ideias ranqueadas com base no Request for Builders da Arc, nos building blocks já disponíveis, nos apps de exemplo e nos programas em andamento, cada uma com fontes, prazos e um plano para as 2 primeiras horas. |
| `new-app` | Gera um starter numa pasta vazia. Starter nº 1, `payouts`: folha de pagamento a partir de um CSV, com linhas `Memo.memo(USDC.transfer)` agrupadas via `Multicall3From` a partir de uma EOA, conciliadas pelos receipts num ledger de 18 decimais, retomada idempotente e deploy estático no GitHub Pages. Testnet por padrão. |
| `gotchas` | Explica um alerta do guard, varre um repositório e liga ou desliga o guard de edição depois da sua confirmação. |
| `go-live` | Checklist de testnet para mainnet (14 gates) com evidências, gravado em `docs/go-live-report.md`. Nunca faz deploy e nunca mexe em chaves. |
| `studio-delegate` | Passa a escrita de contratos, auditorias ou deploys em testnet para a CLI do Arc Studio, da Circle, e trata a saída dela como não confiável até ser conferida onchain. O login no Arc Studio é feito por você. |
| `analyst` | Brainstorming e pesquisa rápida de mercado ou técnica; a busca por ideias passa pelo `find-idea`. |
| `pm` | PRD em `docs/plan/prd.md` com uma seção Onchain (rede, ativos, EOA ou smart account, blocklist, taxas em USDC). |
| `ux-designer` | Specs de UX com os estados da Arc: um único saldo em USDC, taxas em USDC, finalidade com uma confirmação, transações descartadas e revertidas, banner de testnet. |
| `architect` | Espinha da arquitetura que parte das invariantes de protocolo da Arc, mais uma checagem de prontidão. |
| `dev` | Implementa uma story por vez, com o teste antes do código e testes de contrato no Arc Foundry. Uma story só está pronta com testes passando e um hash de transação de testnet registrado. |
| `tech-writer` | Docs, textos explicativos e diagramas Mermaid, com uma fonte em docs.arc.io para cada fato sobre a Arc. |
| `product-brief` | Brief de uma a duas páginas em `docs/plan/brief.md`. |
| `architecture` | Cria, atualiza ou valida `docs/plan/architecture.md`. |
| `stories` | Épicos e arquivos de story prontos para desenvolvimento, com critérios de aceite da Arc. |
| `layered-review` | Code review em camadas independentes, incluindo um caçador de gotchas da Arc que roda a varredura do guard. |

As skills de papéis e os workflows compartilhados (de `analyst` a `layered-review`) são adaptados do [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) v6.12.1 (MIT); veja [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) e [`skills/UPSTREAM.md`](plugins/stable-build/skills/UPSTREAM.md). O plugin opcional `stable-build-mcp` adiciona o servidor MCP de docs da Arc (`https://docs.arc.io/mcp`) e, no Claude Code, o servidor de docs de codegen da Circle (`https://api.circle.com/v1/codegen/mcp`); veja [o README dele](plugins/stable-build-mcp/README.md).

## O guard

Uma verificação apenas informativa que roda depois de cada Write/Edit (Claude Code) ou apply_patch (Codex) dentro de um projeto Arc e olha só as linhas que acabaram de ser adicionadas.

- **Desligado até você aceitar.** O launcher do hook sai sem iniciar o Node, a menos que `~/.stable-build/config.json` contenha `"guard": true`. O Codex também exige que você marque os hooks como confiáveis em `/hooks`.
- **Apenas informativo.** A edição já foi aplicada; o guard nunca bloqueia, desfaz ou reescreve nada e sempre sai com 0, então nunca aparece como erro de hook. Todo alerta, error ou warn, volta do mesmo jeito, no máximo 5 por edição:
  - você vê um aviso de uma linha no idioma salvo (o `systemMessage` do hook), por exemplo "stable-build guard: 1 pegadinha da Arc em src/history.ts (transfer-filter-no-emitter) — aviso, edição mantida" em português, ou `stable-build guard: 1 Arc gotcha in src/history.ts (transfer-filter-no-emitter) — advisory, edit kept` em inglês;
  - o agente recebe os detalhes como contexto adicional (`hookSpecificOutput.additionalContext`, no máximo 2.000 caracteres): `[error]` ou `[warn]`, id da regra, arquivo:linha, a correção, o link da documentação e o trecho datado da documentação que sustenta a regra, para que o agente aplique a correção sem precisar abrir a página.
- **Local.** Sem chamadas de rede, sem gravar arquivos, sem telemetria. Se o Node não estiver instalado, se faltar um arquivo do plugin ou ele estiver quebrado, ou se qualquer outra coisa falhar, ele sai com 0 em silêncio.
- **Só em projetos Arc.** Um projeto conta como Arc quando tem `.stable-build/project.json` ou algum marcador, como o chain id 5042 ou 5042002, `arc`/`arcTestnet` vindo de `viem/chains`, uma URL `rpc.*.arc.io` ou o endereço do USDC `0x3600…0000`.
- **Varredura sob demanda**, sem o hook: `node <plugin>/scripts/guard.mjs --scan .` (sai com 0 se estiver limpo, 1 se houver erros). `--explain <id>` mostra uma regra com o trecho da documentação.
- **Silencie** uma linha com um comentário `stable-build-ignore <id>` nela ou na linha de cima; desative uma regra num projeto em `.stable-build/guard.json` (`{"disable": ["<id>"], "ignorePaths": ["glob"]}`).

| Regra | Severidade | O que aponta | Fonte |
|---|---|---|---|
| `usdc-native-value-6dp` | error | Valor de transação nativa ou `msg.value` montado com 6 decimais; o USDC nativo usa 18 | https://docs.arc.io/integrate/wallets |
| `usdc-erc20-amount-18dp` | error | `transfer` / `approve` / `transferFrom` de USDC com valores de 18 decimais; a interface ERC-20 usa 6 | https://docs.arc.io/arc/references/contract-addresses |
| `usdc-balance-summed` | error | `getBalance` somado a `balanceOf`, ou duas linhas de saldo de USDC: é um saldo só, com duas visões | https://docs.arc.io/integrate/wallets |
| `fee-below-floor` | error | `maxFeePerGas` ou `gasPrice` abaixo de 20 gwei; essas transações nunca recebem receipt (são descartadas ou rejeitadas com `transaction underpriced`) | https://docs.arc.io/arc/references/evm-differences |
| `getlogs-unpaged` | error | Consultas de logs de um bloco fixo até o mais recente sem paginação, ou intervalos acima de 10.000 blocos (o limite do RPC; a correção pagina de 9.999 em 9.999 blocos, como a documentação recomenda) | https://docs.arc.io/arc/references/rpc-endpoints |
| `transfer-filter-no-emitter` | error / warn | Filtros de `Transfer` sem endereço ou com os dois emissores de USDC, inclusive via loop pelos dois (contagem dupla); só em `0x3600…` (perde os envios nativos); ou os dois emissores em consultas separadas no mesmo arquivo | https://docs.arc.io/arc/references/usdc-system-events |
| `cctp-stellar-no-forwarder` | error | Burn de CCTP para a Stellar (domínio 27) cujo mintRecipient ou destinationCaller não é o CctpForwarder (formas com ethers, com viem `write([…])` e com objeto), ou é zero | https://developers.circle.com/cctp/references/stellar |
| `upstream-foundry` | warn (error na CI) | `foundryup`, `foundry-toolchain`, `forge` / `anvil` / `cast send` sem prefixo; também `arc-forge test` / `arc-anvil` sem o modo Arc (`--network arc`, ou `FOUNDRY_PROFILE=arc` com `[profile.arc] network = "arc"`), que rodam com as regras do Ethereum | https://docs.arc.io/arc/references/evm-differences |
| `extension-from-smart-account` | error | Memo ou Multicall3From usados a partir de uma smart account, Safe, bundler ou outro contrato; eles só aceitam uma EOA chamando diretamente | https://docs.arc.io/arc/concepts/transaction-memos |
| `multicall3from-value` | error | `aggregate3Value`, ou value em `aggregate3` via Multicall3From, que não repassa value | https://docs.arc.io/arc/concepts/batched-transactions |

O trecho da documentação e a data `verified_at` de cada regra estão em [`data/gotchas.json`](plugins/stable-build/data/gotchas.json). Toda semana a CI confere cada trecho com a página publicada e abre uma issue quando algum deles muda.

## Desinstalação

Se você usou o instalador:

```sh
curl -fsSL https://raw.githubusercontent.com/pedro-pelicioni/stable-build/main/install.sh | bash -s -- --uninstall
```

Ele remove, em ordem inversa, só o que o manifesto diz que ele adicionou, pergunta antes de remover o plugin da Circle, apaga `manifest.json` e `config.json` em `~/.stable-build` (de um `config.json` que também tenha chaves suas, só saem as chaves de idioma e do guard) e a pasta, só se não houver mais nada nela, depois lista de novo os dois hosts e sai com 1 se sobrar alguma entrada do stable-build. Ele nunca roda `arc-studio logout`. O Claude Code 2.1.280 pode deixar objetos `enabledPlugins` e `extraKnownMarketplaces` vazios no `settings.json`; eles não causam problema.

À mão:

```text
# Claude Code
/plugin uninstall stable-build-mcp@stable-build
/plugin uninstall stable-build@stable-build
/plugin marketplace remove stable-build

# Codex (UNVERIFIED)
codex plugin remove stable-build-mcp@stable-build
codex plugin remove stable-build@stable-build
codex plugin marketplace remove stable-build

# Both
rm -f ~/.stable-build/manifest.json ~/.stable-build/config.json
rmdir ~/.stable-build
```

Remova o plugin da Circle (`circle-skills@circle`, no Codex `circle@circle-skills`) só se você não o usa em outro lugar.

## Privacidade

- Sem telemetria, analytics ou contadores de instalação, seja no instalador, nos hooks ou nas skills.
- O guard roda localmente e não envia nada.
- Prompts que acionam os servidores MCP opcionais enviam a consulta para docs.arc.io ou para a Circle. Não coloque segredos neles.
- Fora essas consultas MCP, as skills perguntam antes de fazer chamadas de rede: `find-idea` pode rodar `gh search repos` para obter metadados de repositórios públicos, `go-live --online` faz chamadas RPC somente leitura (`eth_chainId`, `eth_getCode`) e `gh repo view`, e `studio-delegate` envia a tarefa que você aprovar ao Arc Studio pela sua própria CLI, já logada.
- Nenhuma skill pede, lê ou guarda chaves privadas, seed phrases ou o conteúdo de `.env`, e nenhuma assina ou envia transações. O starter de payouts lê a chave de assinatura do seu shell só quando você mesmo roda a CLI dele.

## Status e itens UNVERIFIED

O que foi executado (2026-10-04):

- `claude plugin validate --strict` passa no marketplace e nos dois plugins (Claude Code 2.1.280). Com `--plugin-dir`, as 16 skills e os dois hooks carregam, e os dois servidores MCP aparecem como Connected.
- Os testes em Node passam: o guard (cada regra contra fixtures boas e ruins, quatro formatos de payload, exit codes, latência p95 abaixo de 150 ms), frontmatter e links das skills, o parser de resultados do Arc Studio e o scaffolder.
- O ciclo completo do instalador passa com CLIs stub (instalar, rodar de novo sem mudanças, atualizar, trocar de ref, desinstalar sem deixar resíduo, download truncado não faz nada) e com o Claude Code 2.1.280 de verdade, num HOME descartável.
- O starter de payouts é gerado, passa nos seus 89 testes offline contra receipts gravados da Arc Testnet, faz o build e passa limpo pela varredura.
- A composição em lote (`Multicall3From.aggregate3` sobre `Memo.memo(USDC.transfer)` a partir de uma EOA) não está documentada em docs.arc.io. Ela foi confirmada só com leituras, a partir de 72 transações já existentes na Arc Testnet; veja [`batch-memo-evidence.md`](plugins/stable-build/skills/new-app/templates/payouts/docs/batch-memo-evidence.md).

Ainda não executado, ou UNVERIFIED:

- **Codex: nada foi executado.** O Codex não está instalado na máquina de build. Os manifestos do Codex, os comandos `codex plugin`, o tratamento do `config.toml`, os payloads de hook, a confiança em `/hooks` e a forma como as skills são listadas vêm só da documentação e do código-fonte do Codex (openai/codex em `4ad985e`).
- **shellcheck e actionlint** rodam só na CI; a CI ainda não rodou porque nada foi enviado ao GitHub.
- **Versão mínima do Claude Code**: só a 2.1.280 foi testada; versões mais antigas são recusadas.
- **Starter de payouts**: o teste end-to-end do próprio starter em testnet precisa de uma chave de testnet com saldo e não foi executado. Não verificados: um lote real na mainnet, o tamanho de chunk em produção (começa com 50 linhas), os rate limits dos RPCs públicos e remetentes delegados via EIP-7702 (recusados pelo starter).
- **Arc Studio**: nenhuma execução real (precisa de login); as fixtures do parser são sintéticas, montadas a partir do código-fonte da versão 1.1.3.
- **go-live**: a URL de verificação de contratos da mainnet e `--account` / `--ledger` / `arc-cast code` no Arc Foundry não estão documentados em docs.arc.io.
- **Dados de programas**: os prazos em `data/programs.json` têm um `valid_until`; quando um deles vence, a checagem de dados falha até a entrada ser atualizada. Vários detalhes de programas estão marcados como UNVERIFIED no arquivo.

## Como contribuir

Veja [CONTRIBUTING.md](CONTRIBUTING.md) e [AGENTS.md](AGENTS.md). Rode `npm test` e `npm run check` antes de abrir um pull request. Relatos de segurança: [SECURITY.md](SECURITY.md).

## Licença

MIT para o código e o texto do próprio stable-build ([LICENSE](LICENSE)). O material adaptado do BMad Method mantém o aviso MIT dele; as skills da Circle e a CLI do Arc Studio são buscadas na origem, não redistribuídas. Detalhes em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
