# Matriz de capacidades por proveedor

Verificada el **2026-11-09** en Windows con VS Code 1.145 (Node 24).
Cada fila indica **cómo se comprobó**: en un equipo real, leyendo el esquema o el binario de la versión instalada, y no
solo la documentación. Si cambia una versión, hay que repetir la comprobación: la columna «Cómo se verificó» dice cómo.

## Versiones instaladas

| Pieza | Versión |
|---|---|
| Claude Code CLI (`claude`, npm) | 2.1.300 |
| Claude Code for VS Code (`anthropic.claude-code`) | 2.1.319 (trae su binario `claude.exe`) |
| Codex CLI (`codex`) | codex-cli 0.167.0 |
| Codex – OpenAI (`openai.chatgpt`) | 26.1021.22027 |
| Google Antigravity (`google.google-antigravity`) | 1.11.0 |
| Antigravity CLI (`agy`) | 1.5.3 |
| Gemini CLI (`gemini`) | **no instalado** |
| Gemini Code Assist (`google.geminicodeassist`) | **no instalado** |

Ninguna de estas extensiones declara una API exportada: el campo `api` falta en sus `package.json` y `activate()` no
devuelve nada útil. Por eso AI Control Center no lee el estado interno de otras extensiones.

## Codex

| Dato | Interfaz oficial | Estado | Cómo se verificó |
|---|---|---|---|
| Cuota por ventana | `codex app-server` → `account/rateLimits/read` | **Implementado, datos reales** | `codex app-server generate-json-schema` y llamada en vivo: `rateLimitsByLimitId.codex` devuelve primary 300 min y secondary 10 080 min, con `usedPercent` y `resetsAt` (epoch en segundos) |
| Cambios de cuota | notificación `account/rateLimits/updated` (dispersa) | Se recibe mientras el proceso vive; el ciclo es corto y relee con `rateLimits/read` | esquema `AccountRateLimitsUpdatedNotification` |
| Identidad y plan | `account/read` con `refreshToken:false` | **Implementado** | en vivo: `type: chatgpt`, `planType: <plan>`. El correo se enmascara y el id de cuenta solo se guarda como hash |
| Tokens diarios de la cuenta | `account/usage/read` → `dailyUsageBuckets` | **Implementado** (tabla aparte, no es cuota) | en vivo |
| Límite individual / créditos | campos `individualLimit`, `credits`, `rateLimitReachedType`, `ordinaryUsageAllowed` | Se guardan como extra y se muestran | esquema |
| Consumo local | `CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, eventos `token_count` | **Implementado** | `total_token_usage` es acumulado (sirve de clave) y `last_token_usage` es el incremento. Un `token_count` repetido con el mismo total no se cuenta dos veces |
| Cuota guardada en el rollout | `token_count.rate_limits` (snake_case) | Se usa como respaldo con confianza «medium» | mismos valores que el servidor, con `resets_at` ±1 s |
| Cuenta con API key | `account/read` → `type: apiKey` | Modo degradado: «cuota no disponible» con el error devuelto | el esquema distingue `ApiKeyAccount` |
| Perfiles aislados | `CODEX_HOME` | `Vincular perfil` crea la carpeta, `account/read` verifica la identidad y se avisa si dos perfiles son la misma cuenta | `initialize` devuelve `codexHome` |

Efecto lateral conocido: el App Server oficial puede renovar el token por su cuenta, igual que lo hace la extensión
de Codex. AI Control Center no lee ni escribe `auth.json`.

## Claude Code

| Dato | Interfaz oficial | Estado | Cómo se verificó |
|---|---|---|---|
| Identidad y plan | `claude auth status` (JSON) | **Implementado** | en vivo: `loggedIn`, `authMethod: claude.ai`, `subscriptionType: <plan>`, `orgId` (guardado como hash), `email` (enmascarado) |
| Cuota 5 h / 7 d | JSON que Claude Code pasa a **statusLine**: `rate_limits.five_hour` / `seven_day`, con `used_percentage` y `resets_at` | **Implementado, opcional** (captura con respaldo y reversión) | documentación embebida en el binario 2.1.319 y en el del npm 2.1.300. Solo aparece en suscriptores, después de la primera respuesta y mientras `resets_at` no haya pasado |
| **Cuota en vivo en cualquier superficie (recomendado)** | mod `ai-control-center-feed` (`apps/claude-mod`): evento oficial `session.measure` de la API de mods, con los mismos `rateLimits` que la statusLine (`five_hour`/`seven_day`, `percentUsed`, `resetsAt`) más el % de contexto y el coste | **Implementado** (confianza «high») | Se dispara tras cada turno y cuando una ventana sube un punto, también en el panel de VS Code, donde la statusLine no corre. Escribe `inbox/claude-mod-<sesión>.json` y nada más. API de mods en «early access»: puede cambiar entre versiones |
| Cuota sin configurar nada (desde 2026-11-09) | `cachedUsageUtilization` en `~/.claude.json` (o `<CLAUDE_CONFIG_DIR>/.claude.json`): la caché de `/usage` que escribe Claude Code. Trae `limits[]` con `kind`, `percent`, `severity`, `resets_at` y `scope.model` | **Implementado** (confianza «medium») | Es una caché **no documentada**: si cambia el formato, no se muestra nada. Solo se lee esa clave. Su frescura depende de cuándo la refresque Claude Code: `fetchedAtMs` fija la antigüedad y, pasados 30 min, el dato se marca «desactualizado» |
| Aviso de límite | mensaje sintético en el transcript: «You've hit your 5-hour/session limit · resets 5:30pm (America/Guayaquil)» | **Implementado** | Se guarda como «100 % hasta la hora de reinicio» y vale hasta esa hora. Al instalarse, la extensión relee una vez los transcripts para recuperar los avisos antiguos |
| ¿El panel gráfico de VS Code ejecuta statusLine? | — | **No**: la cuota se captura solo con sesiones `claude` en terminal | el webview de la extensión no invoca el `statusLine.command` del usuario |
| `/usage` del panel | — | **No es API de terceros**, no se usa | — |
| Métricas de cuota por OTel | — | **No existen** | las únicas métricas OTel del binario son `claude_code.token.usage`, `cost.usage`, `session.count`, `active_time.total`, `lines_of_code.count`, `commit.count`, `pull_request.count`, `code_edit_tool.decision` y otras de herramientas. Ninguna es de cuota |
| Tokens / costo / sesiones por OTel | `CLAUDE_CODE_ENABLE_TELEMETRY=1` + OTLP http/json | **Implementado, opcional** | receptor en 127.0.0.1. Se atribuye por `OTEL_RESOURCE_ATTRIBUTES=acc.profile=<id>`; un punto sin atribuir se descarta |
| Consumo local sin configurar nada | `CLAUDE_CONFIG_DIR/projects/**/*.jsonl`, `message.usage` | **Implementado** | un mismo `message.id` aparece en varias líneas (una por bloque) y gana la última. Los mensajes `<synthetic>` se ignoran |
| Perfiles aislados | `CLAUDE_CONFIG_DIR` | `Vincular perfil` + `claude auth status` con esa variable | `configDirectory` en la salida |

## Gemini

| Producto | Detección | Cuota | Motivo |
|---|---|---|---|
| **Google Antigravity** (instalado) | extensión `google.google-antigravity` + CLI `agy` | **Solo el agotamiento**: «100 % · reinicia …» con la hora del servidor. Fuera de eso, % desconocido | No exporta API ni comando de uso o cuota, y no escribe porcentajes ni tokens en ningún archivo: `doRefreshQuota` aparece en el log sin valores. Sí registra, en `~/.gemini/antigravity-cli/log/cli-*.log` (glog, hora local), cada ejecución (modelo, conversación, pasos, inicio y fin) y el error del servidor `RESOURCE_EXHAUSTED (429): Individual quota reached … Resets in 120h0m0s`. Eso es lo único que se lee: nunca el prompt ni los archivos de sesión. El agotamiento vale hasta la hora de reinicio. Una ejecución posterior completada indica que hay cuota, pero el % sigue desconocido |
| Gemini Code Assist personal / Google AI Pro / Ultra | extensión `google.geminicodeassist` | **No compatible** desde 2026-06-18 | retirada oficial del inicio de sesión de consumidor en IDE y CLI |
| Gemini Code Assist Standard/Enterprise | misma extensión | **No disponible** | la extensión no expone métricas públicas |
| Gemini CLI | `gemini --version` | **No implementado** | no hay CLI instalado para verificarlo. Su OTel opt-in da tokens y solicitudes, no cuota de suscripción |

## Qué NO se hace (por diseño)

- No se leen `auth.json`, `.credentials.json`, `oauth_creds.json`, cookies ni llaveros.
- No se llaman endpoints privados ni se hace scraping de páginas de cuenta.
- No se invocan comandos internos de otras extensiones.
- Ni la cuenta ni la sesión cambian de forma automática.
- Nunca se calcula un porcentaje de cuota a partir de tokens.
