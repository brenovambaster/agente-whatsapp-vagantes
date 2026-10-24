// Ferramentas que o agente pode usar. O token fica aqui, fora do contexto do modelo.
// Contratos conferidos no backend (InscricaoController, PagamentoController e DTOs).
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const API = (process.env.VAGANTES_API || "https://vagantesmoc.com/api").replace(/\/+$/, "");

// Token: VAGANTES_TOKEN fixo (expira em 1h) ou login automático com VAGANTES_ADMIN_EMAIL/SENHA, renovado antes de expirar.
let cached = { token: process.env.VAGANTES_TOKEN || null, exp: Infinity };

async function getToken(force = false) {
  const { VAGANTES_ADMIN_EMAIL: email, VAGANTES_ADMIN_SENHA: senha } = process.env;
  if (!email || !senha) return cached.token;
  if (!force && cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const res = await fetch(`${API}/authenticate`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${email}:${senha}`).toString("base64")}` },
  });
  if (!res.ok) throw new Error(`login na API do Vagantes falhou (${res.status})`);
  const token = (await res.text()).trim();
  const { exp } = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  cached = { token, exp: exp * 1000 };
  return token;
}

async function api(method, path, body, retry = true) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry && process.env.VAGANTES_ADMIN_EMAIL) {
    await getToken(true);
    return api(method, path, body, false);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text.slice(0, 1000); }
  return { ok: res.ok, status: res.status, data };
}

// Campos nulos/vazios só gastam tokens no contexto do modelo.
const vazio = (v) => v === null || v === "" || (Array.isArray(v) && !v.length);
const out = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, (_k, v) => (vazio(v) ? undefined : v)) }] });

// O backend sobrescreve todos os campos do pagamento em "informar"; reenviamos os atuais e só acrescentamos notas.
export async function anotarPagamento(inscricaoId, notas) {
  notas = notas.map((n) => n?.trim()).filter(Boolean);
  if (!notas.length) return null;
  const pag = await api("GET", `/pagamentos/inscricoes/${inscricaoId}`);
  if (!pag.ok) return { etapa: "buscar_pagamento", status: pag.status, erro: pag.data };
  const p = pag.data;
  const atual = (p.observacao || "").trim();
  const novas = notas.filter((n) => !atual.includes(n));
  if (!novas.length) return { ok: true, observacao: atual, pagamentoId: p.id };
  const res = await api("POST", `/pagamentos/inscricoes/${inscricaoId}/usuario/${p.usuarioId}`, {
    metodo: p.metodo || "PIX",
    comprovanteUrl: p.comprovanteUrl ?? null,
    codigoTransacao: p.codigoTransacao ?? null,
    observacao: [atual, ...novas].filter(Boolean).join(" | "),
  });
  return res.ok
    ? { ok: true, pagamentoId: res.data.id, observacao: res.data.observacao, valor: res.data.valor, statusPagamento: res.data.status }
    : { etapa: "atualizar_observacao", status: res.status, erro: res.data };
}

const notasDe = (responsavelNome, observacaoPagamento) => [
  responsavelNome?.trim() && `Responsável: ${responsavelNome.trim()}`,
  observacaoPagamento,
];

async function gravarEmbarque(inscricaoId, localEmbarque) {
  if (!localEmbarque?.trim()) return undefined;
  const up = await api("PATCH", `/inscricoes/${inscricaoId}`, { localEmbarque: localEmbarque.trim() });
  return up.ok ? up.data.localEmbarque : { erro: up.data, status: up.status };
}

// Criar → CONFIRMAR (o backend sempre cria como AGUARDANDO_PAGAMENTO e ignora "status" no POST) → embarque → notas do pagamento.
export async function inscreverPassageiro({ cpf, eventoId, poltrona, localEmbarque, responsavelNome, observacaoPagamento }) {
  const insc = await api("POST", "/inscricoes/cpf", { cpf, eventoId, aceiteTermoRisco: true, ...(poltrona && { poltrona }) });
  if (!insc.ok) return { etapa: "inscricao", status: insc.status, erro: insc.data };
  const inscricaoId = insc.data.id;
  const resultado = { inscricaoId, passageiro: insc.data.usuarioNome, roteiro: insc.data.eventoTitulo };

  const conf = await api("PATCH", `/inscricoes/${inscricaoId}/confirmar`, {});
  resultado.statusInscricao = conf.ok ? conf.data.status : { erro: conf.data, status: conf.status, atual: insc.data.status };

  const embarque = await gravarEmbarque(inscricaoId, localEmbarque);
  if (embarque !== undefined) resultado.localEmbarque = embarque;
  const pagamento = await anotarPagamento(inscricaoId, notasDe(responsavelNome, observacaoPagamento));
  if (pagamento) resultado.pagamento = pagamento;
  return resultado;
}

export const inscreverSchema = {
  cpf: z.string().regex(/^\d{11}$/),
  eventoId: z.string().uuid(),
  poltrona: z.number().int().positive().optional(),
  localEmbarque: z.string().max(255).optional().describe("Ponto de embarque deste passageiro, só se informado no texto"),
  responsavelNome: z.string().min(3).optional().describe("Nome de quem reservou por este passageiro; vira 'Responsável: <nome>'"),
  observacaoPagamento: z.string().max(500).optional().describe("Nota livre na observação do pagamento, ex.: 'pago total, 2 vagas'"),
};

export const vagantesServer = createSdkMcpServer({
  name: "vagantes",
  version: "1.2.0",
  tools: [
    tool(
      "buscar_usuario_por_cpf",
      "Consulta se já existe usuário com o CPF (11 dígitos). 200 = existe, 404 = não existe.",
      { cpf: z.string().regex(/^\d{11}$/) },
      async ({ cpf }) => out(await api("GET", `/user/by-cpf?cpf=${cpf}`)),
    ),
    tool(
      "cadastrar_usuario",
      "Cria um usuário (POST /user). Envie dados já normalizados e validados conforme as regras.",
      {
        nomeCompleto: z.string().min(3).max(100),
        email: z.string().email().nullable(),
        senha: z.string().min(8).max(100),
        telefone: z.string().regex(/^\d{10,11}$/),
        dataNascimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        cpf: z.string().regex(/^\d{11}$/),
        contatoEmergenciaNome: z.string().min(1),
        contatoEmergenciaParentesco: z.string().min(1),
        contatoEmergenciaTelefone: z.string().regex(/^\d{10,11}$/),
        condicoesMedicas: z.string(),
      },
      async (user) => out(await api("POST", "/user", user)),
    ),
    tool(
      "listar_roteiros",
      "Lista roteiros (eventos) abertos para achar o eventoId. Filtre por parte do título.",
      { titulo: z.string().optional() },
      async ({ titulo }) => {
        const q = new URLSearchParams({ page: "0", size: "30" });
        if (titulo) q.set("titulo", titulo);
        const r = await api("GET", `/eventos?${q}`);
        if (!r.ok) return out(r);
        const roteiros = (r.data.content || []).map((e) => ({
          id: e.id, titulo: e.titulo, tipo: e.tipo, dataInicio: e.dataInicio, valor: e.valor,
          status: e.status, vagas: e.maxPessoas != null ? e.maxPessoas - (e.vagasPreenchidas || 0) : null,
          pontoEncontro: e.pontoEncontro,
        }));
        return out({ ok: true, roteiros });
      },
    ),
    tool(
      "inscrever_passageiro",
      "Pipeline completo de UM passageiro já cadastrado: cria a inscrição pelo CPF já com status CONFIRMADO, grava o local de embarque " +
        "(se informado) e acrescenta notas na observação do pagamento gerado. Chame uma vez por passageiro.",
      inscreverSchema,
      async (args) => out(await inscreverPassageiro(args)),
    ),
    tool(
      "atualizar_inscricao",
      "Correção de uma inscrição existente: local de embarque, confirmar a inscrição e/ou acrescentar notas na observação do pagamento.",
      {
        inscricaoId: z.string().uuid(),
        localEmbarque: z.string().max(255).optional(),
        confirmar: z.boolean().optional().describe("true para mudar o status da inscrição para CONFIRMADO"),
        responsavelNome: z.string().min(3).optional(),
        observacaoPagamento: z.string().max(500).optional(),
      },
      async ({ inscricaoId, localEmbarque, confirmar, responsavelNome, observacaoPagamento }) => {
        const r = { inscricaoId };
        if (confirmar) {
          const c = await api("PATCH", `/inscricoes/${inscricaoId}/confirmar`, {});
          r.statusInscricao = c.ok ? c.data.status : { erro: c.data, status: c.status };
        }
        const embarque = await gravarEmbarque(inscricaoId, localEmbarque);
        if (embarque !== undefined) r.localEmbarque = embarque;
        const pagamento = await anotarPagamento(inscricaoId, notasDe(responsavelNome, observacaoPagamento));
        if (pagamento) r.pagamento = pagamento;
        return out(r);
      },
    ),
  ],
});
