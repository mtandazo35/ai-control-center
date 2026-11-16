# AI Control Center

Supervisa dentro de VS Code las cuotas oficiales y el consumo local de **Claude Code**, **Codex** y el producto
Gemini que tengas instalado, por cuenta y perfil de ejecución. Muestra alertas e historial, y recomienda qué cuenta
usar para la siguiente tarea. No cambia de cuenta por su cuenta, no pide credenciales y no lee archivos de tokens.

## Qué ves

- **Barra lateral** (ícono en la Activity Bar): cada perfil con sus ventanas de cuota, la fuente de cada dato,
  su antigüedad, la hora de reinicio, los tokens de las últimas 24 h, las sesiones activas y el estado de verificación.
- **Barra de estado**: `AI: Codex 5h 78% · …` solo con datos oficiales vigentes. Si no los hay:
  `AI: 2 cuentas · 1 sin datos`.
- **Dashboard** (`AI Control Center: Dashboard`): tarjetas que separan la *Cuota oficial* del *Consumo medido por la app*,
  la comparación por capacidad, el bloque «Qué uso ahora», un gráfico de tokens (24 h/7 d/30 d), costos aparte,
  las sesiones y las alertas.

## De dónde sale cada dato

| Proveedor | Cuota oficial | Consumo local |
|---|---|---|
| Codex | `codex app-server` → `account/rateLimits/read` (todos los buckets), con la sesión que ya tienes | `CODEX_HOME/sessions/**/rollout-*.jsonl` (solo contadores) + `account/usage/read` |
| Claude Code | `rate_limits` del JSON de **statusLine**, solo si habilitas la captura (opcional, con respaldo y reversible) | `~/.claude/projects/**/*.jsonl` (solo `message.usage`) u OpenTelemetry local (opcional) |
| Gemini / Antigravity | **No disponible**: el producto instalado no expone ninguna interfaz oficial de cuota; solo se detecta el aviso de cuota agotada en sus registros | `~/.gemini/antigravity-cli/conversations/*.db` (solo los contadores de tokens, el contexto y el modelo de cada llamada) |

Una cuenta sin cuota oficial aparece como «No disponible · solo consumo local» y nunca se puntúa como libre.

## Comandos

`Dashboard`, `Detectar herramientas`, `Actualizar datos`, `Vincular perfil`, `Editar perfil`, `Probar conector`,
`Ver origen del dato`, `Elegir siguiente cuenta`, `Abrir perfil de VS Code`, `Abrir terminal con perfil`,
`Exportar (CSV/JSON)`, `Diagnóstico`, `Claude: habilitar/revertir captura de cuota (statusLine)`,
`Claude: habilitar/revertir telemetría OpenTelemetry local`, `Registrar cuota manual`,
`Instalar agente residente (opcional)` y `Desinstalar monitoreo`.

## Privacidad

Los datos se guardan solo en local, en SQLite (`%LOCALAPPDATA%\ai-control-center`). No se guardan prompts, respuestas,
rutas completas ni tokens: solo contadores, el modelo, el id de sesión, el nombre de la carpeta del proyecto y el correo
enmascarado. No se envía nada a ningún servicio externo.
