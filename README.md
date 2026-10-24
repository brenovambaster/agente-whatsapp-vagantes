# WhatsApp → Agente de Cadastro (Claude Agent SDK)

```
WhatsApp ──► Evolution API ──webhook──► server.js ──► Claude Agent SDK ──► API Vagantes
   ▲                                       │          (README de cadastro     (ferramentas
   └──────────── sendText ◄────────────────┘           como system prompt)    com o token)
```

- `src/server.js`: recebe o `messages.upsert`, filtra (sem grupos, sem `fromMe`, só `ALLOWED_NUMBERS`), uma fila por contato, responde via `sendText`.
- `src/agent.js`: o agente especialista. Usa `README-agente-cadastro-usuarios.md` como manual e mantém uma sessão por contato (`/reset` reinicia).
- `src/vagantes-tools.js`: as únicas ferramentas do agente. O token fica aqui; o modelo nunca o vê, e o agente não tem Bash, arquivos nem web.

## Pipeline (cadastro → inscrição → pagamento)

| Ferramenta | Endpoints |
|---|---|
| `buscar_usuario_por_cpf` / `cadastrar_usuario` | `GET /user/by-cpf`, `POST /user` |
| `listar_roteiros` | `GET /eventos?titulo=` |
| `inscrever_passageiro` (um por passageiro) | `POST /inscricoes/cpf` → `PATCH /inscricoes/{id}/confirmar` → `PATCH /inscricoes/{id}` `{localEmbarque}` → `GET` + `POST /pagamentos/inscricoes/{id}/usuario/{usuarioId}` (notas) |
| `atualizar_inscricao` (correções) | confirmar, embarque e notas, em separado |

- **Status:** toda inscrição já fica `CONFIRMADO`. O backend sempre cria como `AGUARDANDO_PAGAMENTO` e ignora `status` no POST, por isso a confirmação é uma chamada separada. Se o roteiro estiver lotado, a confirmação falha e o agente avisa. O status do pagamento não muda.
- **Fechamento da reserva:** o servidor junta as mensagens e só chama o agente quando chega `/fim` ou 🍃 (uma chamada por reserva, não por mensagem). Se o agente fizer uma pergunta, as respostas seguintes vão direto para ele. Quando a reserva termina, a sessão é descartada para o histórico não ser reenviado na próxima.
- **Valor pago:** o pagamento de X (ou de quem reserva só para si) recebe nota como `pago total, 2 vagas`.
- **Responsável:** se X reserva para A e B, os pagamentos de A e B recebem `Responsável: X` na observação. A observação que já existia é mantida, e a nota não se repete.
- **Ponto de embarque:** grava `localEmbarque` na inscrição só quando aparece no texto.
- **Cadastro:** `cadastrar_usuario` normaliza os dados no código (só dígitos em CPF e telefones, data em `AAAA-MM-DD`, nome em title case), preenche os padrões (`Não informado`, `00000000000`, nascimento `2010-10-10`), grava email sempre `null` e gera a senha. A senha não volta para o modelo nem vai para o WhatsApp.
- **Observação do pagamento:** o `informarPagamento` do backend sobrescreve `metodo`, `comprovanteUrl`, `codigoTransacao` e `observacao`. Por isso a ferramenta lê o pagamento atual e reenvia esses campos. O status do pagamento não é alterado.

Exemplo de mensagem:
`Xavier Prado (CPF ...) reservou Itacaré outubro para Ana Souza (CPF ..., embarca na Praça Raul Soares) e Bruno Lima (CPF ...).`

## Subir

1. Evolution API: `docker compose up -d` e troque `AUTHENTICATION_API_KEY` no compose.
2. Criar a instância e apontar o webhook para este serviço:
   ```bash
   curl -X POST http://localhost:8080/instance/create -H "apikey: troque-esta-chave" -H "Content-Type: application/json" \
     -d '{"instanceName":"vagantes","integration":"WHATSAPP-BAILEYS","qrcode":true,
          "webhook":{"url":"http://host.docker.internal:3000/webhook","events":["MESSAGES_UPSERT"],
                     "headers":{"X-Webhook-Secret":"<WEBHOOK_SECRET>"}}}'
   ```
   Leia o QR em `http://localhost:8080/instance/connect/vagantes` (ou no Manager em `http://localhost:8080/manager`) com o WhatsApp do número que vai atender.
3. `cp .env.example .env` e preencha os campos. Os comentários do arquivo explicam cada um. Com a Evolution no Docker, use `HOST=0.0.0.0`.
   Se a sua versão da Evolution não aceitar `headers` no webhook, use a URL `.../webhook/<WEBHOOK_SECRET>`.
   Para descobrir o id de um grupo: `GET /group/fetchAllGroups/<instancia>?getParticipants=false`.
4. `npm install && npm start`

Teste: do número liberado, mande algo como
`Cadastrar: Maria da Silva, CPF 123.456.789-01, tel (38) 99999-9999, nasc 15/05/1990`.

## Observações

- A API do WhatsApp é **não oficial**: o número pode ser banido. Use um chip dedicado.
- Para trocar por outra API (Z-API, WPPConnect, etc.), basta adaptar `extractText`/o filtro do webhook e `sendText` em `server.js`.
- As sessões ficam em memória: reiniciar o serviço zera o contexto das conversas.
- O consumo de tokens de cada chamada aparece no log. Para reduzir o custo, use `CLAUDE_MODEL=sonnet` e `CLAUDE_EFFORT=low` no `.env`.
