// Recebe o webhook da Evolution API, envia o texto ao agente e responde no WhatsApp.
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { askAgent, emAndamento, resetSession } from "./agent.js";

const { EVOLUTION_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE, WEBHOOK_SECRET, HOST = "127.0.0.1", PORT = 3000 } = process.env;
const list = (v) => new Set((v || "").split(",").map((s) => s.replace(/[^\dA-Za-z@.\-]/g, "")).filter(Boolean));
const allowedSenders = list(process.env.ALLOWED_NUMBERS); // números (só dígitos) e/ou ids @lid
const allowedGroups = list(process.env.ALLOWED_GROUPS); // ids terminados em @g.us

async function sendText(to, text) {
  const res = await fetch(`${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
    method: "POST",
    headers: { apikey: EVOLUTION_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ number: to, text }),
  });
  if (!res.ok) console.error("sendText falhou", res.status, await res.text());
}

async function reply(to, text) {
  if (text) await sendText(to, text);
}

function extractText(message = {}) {
  return message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || "";
}

// Identificadores possíveis do remetente: número (s.whatsapp.net) e/ou id interno (@lid).
function senderIds(key, isGroup) {
  const jids = isGroup ? [key.participant, key.participantAlt] : [key.remoteJid, key.remoteJidAlt];
  return jids.filter(Boolean).flatMap((j) => (j.endsWith("@lid") ? [j, j.split("@")[0]] : [j.split("@")[0]]));
}

function secretOk(req) {
  if (!WEBHOOK_SECRET) return true;
  const got = Buffer.from(String(req.get("x-webhook-secret") || req.params.secret || ""));
  const want = Buffer.from(WEBHOOK_SECRET);
  return got.length === want.length && timingSafeEqual(got, want);
}

// Uma fila por conversa: mensagens da mesma conversa são processadas em ordem.
const queues = new Map();
function enqueue(key, job) {
  const next = (queues.get(key) || Promise.resolve()).then(job).catch((e) => console.error(e));
  queues.set(key, next);
}

// Mensagens da reserva ainda aberta. O modelo só é chamado quando chega /fim ou 🍃,
// em vez de uma chamada (com todo o histórico) por mensagem.
const FIM = /^\/fim\b|🍃/iu;
const reservas = new Map();

const app = express();
app.use(express.json({ limit: "5mb" }));

app.post(["/webhook", "/webhook/:secret"], (req, res) => {
  if (!secretOk(req)) return res.sendStatus(401);
  res.sendStatus(200); // responde rápido; o agente roda em segundo plano
  const { event, data } = req.body || {};
  if (!/^messages[._]upsert$/i.test(event || "") || !data?.key || data.key.fromMe) return;

  const chat = data.key.remoteJid || "";
  const isGroup = chat.endsWith("@g.us");
  if (isGroup ? !allowedGroups.has(chat) : !chat.endsWith("@s.whatsapp.net") && !chat.endsWith("@lid")) return;

  const ids = senderIds(data.key, isGroup);
  if (allowedSenders.size && !ids.some((id) => allowedSenders.has(id))) {
    return console.log("ignorado (remetente fora da lista):", ids.join(" / "), isGroup ? `em ${chat}` : "");
  }

  const text = extractText(data.message).trim();
  if (!text) return;

  const conversa = isGroup ? `${chat}|${ids[0]}` : ids[0]; // contexto separado por remetente dentro do grupo
  enqueue(conversa, async () => {
    if (text.toLowerCase() === "/reset") {
      resetSession(conversa);
      reservas.delete(conversa);
      return sendText(chat, "Conversa reiniciada.");
    }
    // Resposta a uma pergunta do agente: vai direto, sem esperar /fim.
    if (emAndamento(conversa)) return reply(chat, await askAgent(conversa, text));

    const msgs = [...(reservas.get(conversa) || []), text];
    if (!FIM.test(text)) return reservas.set(conversa, msgs);
    reservas.delete(conversa);
    await reply(chat, await askAgent(conversa, msgs.join("\n\n---\n\n")));
  });
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(PORT, HOST, () => console.log(`webhook em http://${HOST}:${PORT}/webhook`));
