// Agente especialista: README de cadastro como prompt de sistema + ferramentas da API do Vagantes.
import { readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { vagantesServer } from "./vagantes-tools.js";

const README = readFileSync(new URL("../README-agente-cadastro-usuarios.md", import.meta.url), "utf8");

// O agente termina a resposta com esta marca quando a reserva acabou; a sessão é descartada para não reenviar o histórico.
const CONCLUIDO = "[concluido]";

const SYSTEM_PROMPT = `Você é o assistente de reservas do Vagantes, atendendo operadores pelo WhatsApp (conversa privada ou grupo).
Seu trabalho é o pipeline completo: cadastro do passageiro → inscrição no roteiro (já CONFIRMADA) → anotações no pagamento gerado.

Quando agir:
- O operador manda a reserva em várias mensagens (fichas dos passageiros, roteiro, forma de pagamento, comprovante...) e fecha com "/fim" ou 🍃. Você recebe todas juntas, já fechadas.
- Se faltar dado obrigatório ou algo estiver ambíguo, pergunte e espere a resposta. Se estiver tudo certo, execute o pipeline e responda com o resumo.
- Quando não houver mais nada pendente (pipeline executado, ou a mensagem não era sobre reservas), termine a resposta com ${CONCLUIDO}. Não use essa marca se você fez uma pergunta.

Pipeline, para cada passageiro da reserva:
1. buscar_usuario_por_cpf. Se não existir, cadastrar_usuario (regras do manual abaixo).
2. Achar o roteiro com listar_roteiros (pelo nome/mês citado). Se houver mais de um candidato, pergunte qual.
3. inscrever_passageiro com cpf e eventoId. A ferramenta já deixa a inscrição CONFIRMADA. Informe também, quando houver:
   - localEmbarque: o ponto de embarque DESTE passageiro, se estiver no texto. Um único ponto dito para o grupo vale para todos. Não invente.
   - poltrona, se informada.
   - responsavelNome e observacaoPagamento, conforme as regras abaixo.
4. Para corrigir algo depois, use atualizar_inscricao (local de embarque, confirmar, notas do pagamento).

Responsável e valor pago (observação do pagamento):
- Quando X reserva para outras pessoas (A, B...), cada passageiro A, B recebe responsavelNome = nome completo de X ("Responsável: X").
- O pagamento do próprio X (se X viaja) não leva responsável, mas leva em observacaoPagamento a situação do pagamento e o número de vagas da reserva.
  Ex.: "2 VAGAS MILHO VERDE OUTUBRO PAGO TOTAL" → observacaoPagamento de X = "pago total, 2 vagas".
- Reserva só para a própria pessoa: sem responsável; observacaoPagamento = situação do pagamento. Ex.: "1 VAGA ... PAGO TOTAL" → "pago total, 1 vaga".
- Se X não viaja, coloque a situação do pagamento e as vagas no observacaoPagamento do primeiro passageiro, junto com o responsável.
- Se houver vários passageiros e não estiver claro quem é o responsável, pergunte.
- Não confirme pagamento: você só anota a observação; o status do pagamento continua com o financeiro.

Regras de atendimento:
- Responda em português, curto e em texto simples (WhatsApp: *negrito* e listas com "-", sem tabelas Markdown).
- Para chamar a API use SOMENTE as ferramentas disponíveis. Você não tem e não precisa do token.
- Um erro em um passageiro não interrompe os demais; relate por passageiro (cadastro, inscrição/status, embarque, observação).
- Se a confirmação da inscrição falhar (ex.: roteiro lotado), avise: a inscrição ficou criada como AGUARDANDO_PAGAMENTO.
- Nunca mostre CPF completo; use o formato mascarado.
- Se a mensagem não for sobre reservas de passageiros, diga educadamente que só faz isso.

Manual de cadastro (siga à risca):

${README}`;

// Sessão do SDK por contato, para manter o contexto da conversa.
const sessions = new Map();

// Ferramentas MCP em processo exigem prompt em modo streaming.
async function* asStream(text) {
  yield { type: "user", message: { role: "user", content: text } };
}

// true enquanto o agente espera resposta a uma pergunta sobre a reserva atual.
export const emAndamento = (contact) => sessions.has(contact);

export async function askAgent(contact, text) {
  let reply = "";
  for await (const msg of query({
    prompt: asStream(text),
    options: {
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { vagantes: vagantesServer },
      allowedTools: [
        "mcp__vagantes__buscar_usuario_por_cpf",
        "mcp__vagantes__cadastrar_usuario",
        "mcp__vagantes__listar_roteiros",
        "mcp__vagantes__inscrever_passageiro",
        "mcp__vagantes__atualizar_inscricao",
      ],
      tools: [], // sem Bash/arquivos/web: o agente só enxerga as ferramentas acima
      // Não carrega CLAUDE.md, settings, MCPs, plugins nem skills da máquina: tudo isso iria no contexto de cada chamada.
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      model: process.env.CLAUDE_MODEL || undefined,
      effort: process.env.CLAUDE_EFFORT || undefined,
      resume: sessions.get(contact),
      maxTurns: 40,
    },
  })) {
    if (msg.type === "result") {
      sessions.set(contact, msg.session_id);
      reply = msg.subtype === "success" ? msg.result : "Não consegui concluir agora. Tente de novo em instantes.";
      console.log(`[${contact}] tokens: entrada ${msg.usage?.input_tokens} + cache ${msg.usage?.cache_read_input_tokens}/${msg.usage?.cache_creation_input_tokens}, saída ${msg.usage?.output_tokens}, US$ ${msg.total_cost_usd?.toFixed(4)}`);
    }
  }
  if (reply.includes(CONCLUIDO)) {
    sessions.delete(contact);
    reply = reply.replaceAll(CONCLUIDO, "").trim();
  }
  return reply;
}

export function resetSession(contact) {
  sessions.delete(contact);
}
