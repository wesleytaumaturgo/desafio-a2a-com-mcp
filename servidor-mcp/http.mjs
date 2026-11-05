import { createServer } from 'node:http';

async function lerCorpo(req) {
  const pedacos = [];
  for await (const pedaco of req) pedacos.push(pedaco);
  return Buffer.concat(pedacos);
}

function registrar(corpo) {
  let metodo = '-';
  let id = '-';
  let traceparent = '-';
  try {
    const msg = JSON.parse(corpo.toString('utf8'));
    metodo = msg.method ?? '-';
    id = msg.id ?? '-';
    traceparent = msg.params?._meta?.traceparent ?? '-';
  } catch {
    // corpo ilegivel: o SDK responde o erro de protocolo; o log sai com '-'
  }
  process.stderr.write(`mcp ${metodo} id=${id} traceparent=${traceparent}\n`);
}

function paraRequest(req, corpo) {
  const cabecalhos = new Headers();
  for (const [nome, valor] of Object.entries(req.headers)) {
    if (Array.isArray(valor)) valor.forEach((v) => cabecalhos.append(nome, v));
    else if (valor !== undefined) cabecalhos.set(nome, valor);
  }
  const semCorpo = req.method === 'GET' || req.method === 'HEAD';
  const url = `http://${req.headers.host ?? 'localhost'}${req.url}`;
  return new Request(url, { method: req.method, headers: cabecalhos, body: semCorpo ? undefined : corpo });
}

async function copiarResposta(resposta, res) {
  res.writeHead(resposta.status, Object.fromEntries(resposta.headers));
  if (resposta.body) res.write(Buffer.from(await resposta.arrayBuffer()));
  res.end();
}

export function criarServidorHttp(handler, { caminho = '/mcp' } = {}) {
  return createServer(async (req, res) => {
    try {
      if (new URL(req.url, 'http://localhost').pathname !== caminho) {
        res.writeHead(404).end();
        return;
      }
      const corpo = await lerCorpo(req);
      if (req.method === 'POST') registrar(corpo);
      await copiarResposta(await handler.fetch(paraRequest(req, corpo)), res);
    } catch (erro) {
      process.stderr.write(`mcp erro ${erro?.message ?? erro}\n`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}
