import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { salas, politica } from './dados.mjs';

export const VERSAO_POLITICA = politica.match(/^versao:\s*(\S+)/)[1];

export const ERRO_INTERVALO = 'Intervalo invalido: fim deve ser posterior a inicio';
export const ERRO_JANELA = 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00';
export const ERRO_DURACAO = 'Duracao acima do limite: a politica permite no maximo 2 horas';
export const ERRO_SEM_ALTERNATIVA = 'Sem alternativas disponiveis no intervalo';
export const erroSala = (id) => `Sala inexistente: ${id}`;

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;
const FUSO_SAO_PAULO = -3 * HORA;
const ABERTURA = 8 * HORA;
const FECHAMENTO = 20 * HORA;
const DURACAO_MAXIMA = 2 * HORA;

// Escopo do módulo: a factory do McpServer roda a cada request, então o estado não pode viver nela.
const reservas = JSON.parse(readFileSync(fileURLToPath(new URL('../dados/reservas.json', import.meta.url)), 'utf8'));
let ultimoId = reservas.reduce((maior, r) => Math.max(maior, Number(r.id.slice(4))), 0);

const proximoId = () => `res-${String(++ultimoId).padStart(4, '0')}`;
const sobrepoe = (a, b) => Date.parse(a.inicio) < Date.parse(b.fim) && Date.parse(b.inicio) < Date.parse(a.fim);

function validar(sala, inicio, fim) {
  if (!salas.some((s) => s.id === sala)) return erroSala(sala);

  const ini = Date.parse(inicio);
  const fi = Date.parse(fim);
  if (Number.isNaN(ini) || Number.isNaN(fi) || fi <= ini) return ERRO_INTERVALO;

  const localIni = ini + FUSO_SAO_PAULO;
  const localFim = fi + FUSO_SAO_PAULO;
  const mesmoDia = Math.floor(localIni / DIA) === Math.floor(localFim / DIA);
  if (!mesmoDia || localIni % DIA < ABERTURA || localFim % DIA > FECHAMENTO) return ERRO_JANELA;

  if (fi - ini > DURACAO_MAXIMA) return ERRO_DURACAO;
  return null;
}

const conflitosDe = (sala, inicio, fim) => reservas.filter((r) => r.sala === sala && sobrepoe(r, { inicio, fim }));

export function consultarDisponibilidade({ sala, inicio, fim }) {
  const erro = validar(sala, inicio, fim);
  if (erro) return { erro };
  const conflitos = conflitosDe(sala, inicio, fim).map(({ id, inicio: i, fim: f, responsavel }) => ({ id, inicio: i, fim: f, responsavel }));
  return { disponibilidade: { sala, livre: conflitos.length === 0, conflitos } };
}

export function reservarSala({ sala, inicio, fim, responsavel }) {
  const erro = validar(sala, inicio, fim);
  if (erro) return { erro };
  const conflitos = conflitosDe(sala, inicio, fim);
  if (conflitos.length > 0) return { conflitos };
  const reserva = { id: proximoId(), sala, inicio, fim, responsavel };
  reservas.push(reserva);
  return {
    reserva: { reserva: reserva.id, reservado: true, sala, inicio, fim, responsavel, politica: VERSAO_POLITICA, motivo: null },
  };
}
