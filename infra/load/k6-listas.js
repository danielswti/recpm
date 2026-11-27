/**
 * Teste de carga (§9.10): listas de tarefas e projetos com 200 usuários simultâneos.
 * Critério: p95 < 200 ms nas listas, com 50 workspaces e 100 mil tarefas (seed "load").
 *
 *   1. docker compose run --rm -v /tmp/load:/out api node dist/seed.js load --sessions /out/sessoes.json
 *   2. cp infra/load/k6-listas.js /tmp/load/ && docker run --rm --network host -v /tmp/load:/s -w /s \
 *        -e BASE_URL=https://app.SEU_DOMINIO grafana/k6:1.4.2 run k6-listas.js
 *
 * Cada usuário virtual é uma pessoa (admin, gestor ou equipe) de um dos 50 workspaces, então as
 * consultas passam pelo RLS de verdade. Como uma pessoa real: abre uma tela (lista de tarefas,
 * "minhas tarefas", quadro de um projeto ou projetos) e lê por THINK_MIN–THINK_MAX segundos.
 * Para achar o limite do servidor, rode com THINK_MIN=0.5 THINK_MAX=1.5 (teste de estresse).
 */

import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import http from "k6/http";

const sessions = new SharedArray("sessoes", () => JSON.parse(open("./sessoes.json")));
const BASE = __ENV.BASE_URL || "https://app.recpm.localhost";
const VUS = Number(__ENV.VUS || 200);
const THINK_MIN = Number(__ENV.THINK_MIN || 3);
const THINK_MAX = Number(__ENV.THINK_MAX || 7);

export const options = {
  insecureSkipTLSVerify: __ENV.INSECURE === "1",
  scenarios: {
    listas: {
      executor: "ramping-vus",
      stages: [
        { duration: __ENV.RAMP || "30s", target: VUS },
        { duration: __ENV.HOLD || "3m", target: VUS },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    "http_req_duration{lista:tarefas}": ["p(95)<200"],
    "http_req_duration{lista:minhas}": ["p(95)<200"],
    "http_req_duration{lista:quadro}": ["p(95)<200"],
    "http_req_duration{lista:projetos}": ["p(95)<200"],
    http_req_failed: ["rate<0.01"],
  },
};

const SCREENS = [
  ["tarefas", 40, () => "/api/v1/tasks?scope=all&pageSize=50"],
  ["minhas", 25, () => "/api/v1/tasks?scope=mine&pageSize=50"],
  [
    "quadro",
    25,
    (s) =>
      `/api/v1/tasks?projectId=${s.projects[Math.floor(Math.random() * s.projects.length)]}&sort=board&pageSize=100`,
  ],
  ["projetos", 10, () => "/api/v1/projects?pageSize=50"],
];

function pickScreen() {
  let r = Math.random() * 100;
  for (const sc of SCREENS) {
    r -= sc[1];
    if (r < 0) return sc;
  }
  return SCREENS[0];
}

export default function () {
  const s = sessions[(__VU - 1) % sessions.length];
  const [lista, , path] = pickScreen();
  const r = http.get(`${BASE}${path(s)}`, { headers: { cookie: s.cookie }, tags: { lista } });
  check(r, { 200: (x) => x.status === 200 });
  sleep(THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN));
}
