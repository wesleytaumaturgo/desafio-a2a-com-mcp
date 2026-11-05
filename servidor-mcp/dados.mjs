import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lerDados = (arquivo) => readFileSync(fileURLToPath(new URL(`../dados/${arquivo}`, import.meta.url)), 'utf8');

export const salas = JSON.parse(lerDados('salas.json'));
export const politica = lerDados('politica-de-uso.md');
