# Arquitectura

```text
VS Code — extension host (apps/vscode-extension, dist/extension.js)
  ├── Activity Bar → Tree Views «Cuentas y cuotas» y «Alertas»
  ├── Status Bar  → solo porcentajes oficiales vigentes
  ├── Dashboard Webview (media/dashboard.js, DOM con textContent, CSP con nonce)
  ├── Comandos (Command Palette)
  ├── Receptor OTLP/HTTP 127.0.0.1 (solo si un perfil Claude lo habilitó)
  └── Collector ──────────────┐            (lease «collector»: un solo productor por equipo)
                              ▼
Agente residente opcional (dist/agent.js, mismo Collector, sin VS Code)
                              │
        ┌─────────────────────┼─────────────────────────────┐
        ▼                     ▼                             ▼
  Codex adapter          Claude adapter                Gemini detection
  codex app-server       claude auth status            producto exacto → «No disponible»
  JSON-RPC (stdio)       transcripts (usage)           registro manual
  rollouts (token_count) statusLine inbox / OTLP
        └──────────────┬──────┴─────────────────────────────┘
                       ▼
        SQLite local (node:sqlite, WAL) — %LOCALAPPDATA%\ai-control-center\ai-control-center.sqlite
```

## Qué corre dónde

**En cada PC donde usas Claude Code, Codex o Antigravity (local, obligatorio).** Los datos solo existen ahí: las sesiones
iniciadas de cada herramienta, sus archivos locales y el mod. Nada de esto va en Docker.

| Pieza | Para qué | Cómo se ejecuta |
|---|---|---|
| Sesiones de Claude Code, Codex y Antigravity | tus cuentas, iniciadas en cada herramienta oficial | ya las tienes |
| Mod `ai-control-center-feed` | cuota de Claude en vivo (5 h, semanal, contexto, coste) | plugin de Claude Code, `scope: user` |
| Agente (`dist/agent.js`) | lee `codex app-server`, rollouts, transcripts, caché de `/usage` y registros de Antigravity; guarda en SQLite | arranque con Windows («Instalar agente residente») o `node dist/agent.js --web` |
| SQLite (`%LOCALAPPDATA%\ai-control-center`) | historial local | lo crea el agente |
| Extensión de VS Code | tarjetas, alertas, comandos | `.vsix` instalado |
| Panel web local `127.0.0.1:4320` | ver el dashboard en el navegador del PC | lo sirve el agente (`--web`) o la extensión |

Requisitos del PC: Node ≥ 22 (o VS Code ≥ 1.101), `codex` y `claude` en el PATH.

**En la VPS (fase siguiente, en Docker).** Solo agrega y muestra lo que mandan los agentes: API + PostgreSQL + la misma
web con login de usuario, detrás de TLS. No necesita ninguna sesión de Claude, Codex ni Gemini, y nunca recibe prompts ni
credenciales: solo cifras normalizadas (%, reinicios, tokens, sesiones), enviadas por cada agente con su propio token.

## Flujo de un ciclo de recolección

Cada `pollMinutes` (5 por defecto), o al pulsar «Actualizar datos»:

1. **Lease**: solo una ventana (o el agente) consulta a los proveedores. Las demás ventanas releen la base cada 30 s.
2. Por cada perfil habilitado:
   - **Codex**: se lanza `codex app-server` con `CODEX_HOME` → `initialize` → `account/read {refreshToken:false}` →
     `account/rateLimits/read` → `account/usage/read`, y el proceso termina. Después se leen de forma incremental los
     rollouts nuevos.
   - **Claude**: se leen de forma incremental los transcripts nuevos, y `claude auth status` corre una de cada 6 vueltas.
3. Se ingiere la bandeja de statusLine (`inbox/claude-statusline.jsonl`).
4. Se evalúan las alertas: la clave de cada una es estable por ciclo de ventana y una alerta ya vista no vuelve a avisar.
5. Latido (`agent_heartbeats`) y retención (`retentionDays`).

**Lectura incremental**: hay un cursor de bytes por archivo (`ingest_cursors`). Solo se lee lo añadido desde la última
vez. Una línea a medio escribir se deja para la siguiente pasada, y si un archivo encoge se vuelve a leer desde cero.
Un filtro descarta sin parsear las líneas que no pueden importar (prompts, salidas de herramientas). Cada bloque de
4 MB se aplica en una sola transacción: una primera carga de ~150 000 registros tarda unos segundos y una
pasada incremental, uno o dos segundos.

## Modelo de datos (migración 1)

`users`, `machines`, `provider_accounts` (= perfiles de ejecución), `quota_snapshots`, `token_usage_events`,
`account_daily_usage`, `provider_sessions`, `cost_events`, `routing_recommendations`, `alerts`, `settings`,
`agent_heartbeats`, `audit_logs`, `ingest_cursors` y `leases`.

- Los campos de cuota (`used_percent`, `remaining_percent`, `resets_at`) admiten NULL: un valor desconocido es NULL, nunca 0.
- Cada medida lleva `source`, `confidence`, `observed_at` y `status`.
- Deduplicación: `UNIQUE(machine_id, account_id, limit_id, source, observed_at)` en las cuotas, y `event_key`
  idempotente en tokens y costos.
- Índices por cuenta y fecha. Borrar un perfil borra en cascada su historial.
- Ninguna columna guarda tokens, cookies, prompts ni rutas completas. El proyecto se guarda solo por el nombre de la
  carpeta y la identidad como hash más el correo enmascarado.

## Motor de recomendación

- Por cuenta se evalúa cada ventana oficial. Una ventana puede estar **vigente**, **desactualizada** (más antigua que
  `staleMinutes`), **reiniciada** (si `resets_at` ya pasó, el uso nuevo es desconocido, no 0) o **sin dato**.
- El cuello de botella es la ventana vigente con menos `remaining`.
- Clasificaciones: `recomendable`, `bajo-reserva` (menos que `reservePercent`), `agotada`, `sin-datos`,
  `deshabilitada` y `no-compatible`.
- Puntuación: lo que queda en el cuello de botella; −10 si hay ventanas sin dato vigente, +5 si esa ventana se
  reinicia en menos de 1 h y +5 por continuidad de proveedor (opcional).
- No se comparan tokens entre proveedores. Una cuenta `sin-datos` se muestra, pero no se puntúa.

## ADR breves

1. **VS Code primero, sin backend obligatorio.** El MVP es la extensión con SQLite local. La API NestJS/PostgreSQL,
   la PWA y Electron **no están implementados**: el esquema SQL está aislado en `migrations.ts` para portarlo después.
2. **`node:sqlite` en lugar de better-sqlite3.** VS Code ≥ 1.101 trae Node ≥ 22 con `node:sqlite`, así que el `.vsix`
   no lleva binarios nativos por plataforma. Se verificó con VS Code 1.145 (Node 24).
3. **Webview en JS sin framework** (no Vue/Quasar/ECharts). Un dashboard pequeño no justifica un bundle y una CSP más
   complejos. El gráfico es SVG propio y el DOM se construye con `textContent` (probado contra inyección de HTML).
4. **App Server efímero por ciclo** en lugar de un proceso permanente: menos interferencia con la extensión de Codex
   y ningún estado de sesión colgado.
5. **Cuota de Claude solo por statusLine**, opcional y reversible: es la única interfaz oficial que la expone. El
   envoltorio respeta la statusLine que ya tenga el usuario.
6. **Una fuente de tokens por perfil** (`transcript` u `otel`) para no contar dos veces el mismo uso.
7. **Lease en SQLite** para que varias ventanas y el agente no lancen cada una su propio App Server.
8. **npm en lugar de pnpm**: pnpm no estaba instalado y el repo solo tiene un paquete. La raíz usa npm workspaces y
   migrar a pnpm no exige cambios de código.

## Limitaciones conocidas

- **Claude**: la cuota se refresca solo cuando una sesión `claude` de terminal recibe una respuesta. El uso desde el
  panel gráfico, claude.ai u otras superficies cuenta para la cuota, pero no actualiza la captura hasta la siguiente
  respuesta en terminal.
- **Remote SSH / WSL / devcontainers**: la extensión se ejecuta en el lado UI (local). Las sesiones que corren en otro
  host no se ven, salvo que se fuerce `remote.extensionKind` y el host remoto tenga las CLIs.
- **macOS**: el código no depende de Windows, salvo el instalador del agente (Registro HKCU\Run). No se probó en macOS.
- **Presupuestos de API key**: no hay fuente oficial que consultar con suscripciones, así que la alerta «presupuesto
  excedido» no está implementada.
