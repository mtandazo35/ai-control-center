# AI Control Center

Supervisa, desde tu propio PC, **cuánta cuota te queda en cada cuenta de IA y a qué hora se reinicia**: Claude Code,
Codex y Google Antigravity (Gemini). Junta en un solo lugar lo que cada herramienta muestra por separado, avisa antes de
que te quedes sin cuota y recomienda qué cuenta usar para la siguiente tarea.

- Funciona con las **sesiones de suscripción que ya tienes iniciadas**: no pide usuarios, contraseñas ni claves, y no lee
  archivos de credenciales.
- **Todo es local:** los datos se guardan en tu PC y nada se envía a ningún servicio externo.
- Se usa como **panel web** en tu navegador (`http://127.0.0.1:4320`) y, si quieres, como **extensión de VS Code**.

---

## Índice

1. [Qué muestra](#qué-muestra)
2. [Cómo funciona](#cómo-funciona)
3. [Requisitos](#requisitos)
4. [Instalación en tu PC](#instalación-en-tu-pc)
5. [Comprobar que funciona](#comprobar-que-funciona)
6. [Uso diario](#uso-diario)
7. [De dónde sale cada dato](#de-dónde-sale-cada-dato)
8. [Configuración](#configuración)
9. [Varias cuentas del mismo proveedor](#varias-cuentas-del-mismo-proveedor)
10. [Archivos que crea en tu PC](#archivos-que-crea-en-tu-pc)
11. [Privacidad y seguridad](#privacidad-y-seguridad)
12. [Solución de problemas](#solución-de-problemas)
13. [Actualizar y desinstalar](#actualizar-y-desinstalar)
14. [Desarrollo](#desarrollo)
15. [Próximos pasos](#próximos-pasos)

---

## Qué muestra

**Una tarjeta por cuenta** con:

- **Cuota oficial por ventana**: el porcentaje usado, con una barra azul que pasa a naranja desde el 70 % y a roja desde
  el 95 %, y la hora de reinicio en tu zona («Se reinicia a las 14:40», «Se reinicia jue 19/11 a las 03:00»).
  - Claude: sesión de 5 h, semanal y semanal por modelo.
  - Codex: sesión de 5 h, semanal y cualquier otro bucket que devuelva.
  - Antigravity: sesión de 5 h y semanal de cada grupo de modelos (Gemini; Claude y GPT; Argon), leídas con el comando
    oficial `agy -p "/usage"`, que no inicia un turno ni gasta cuota. Solo el grupo Gemini decide la recomendación.
- **Consumo medido por la app**: tokens de las últimas 24 h (con el desglose entrada, caché y salida al pasar el
  mouse), sesiones activas y contexto de la sesión actual (Claude) o de la última ejecución (Antigravity).
  - Antigravity: tokens y contexto de cada llamada, leídos de sus propias conversaciones locales (solo las cifras y el
    nombre del modelo, nunca el contenido), y una línea por modelo usado en 24 h.
- La cuenta en uso (correo enmascarado), el plan y el estado de la sesión.

**Además:**

- **«Qué uso ahora»**: recomienda la cuenta con más capacidad real y explica por qué. Una cuenta sin dato oficial se
  muestra, pero nunca se puntúa como libre.
- **Comparación** de todas las cuentas por capacidad restante.
- **Gráficos de 24 h, 7 días y 30 días**:
  - **tokens** por cuenta;
  - **actividad** por cuenta (sesiones y ejecuciones).
- **Alertas** al 70, 85 y 95 % de cada ventana, aviso de reinicio próximo, sesión caducada, dato desactualizado y
  recolector caído.
- **Historial** de sesiones (proyecto, modelo, duración y tokens) y de costes estimados.

Todas las horas se muestran en **hora de Ecuador** (America/Guayaquil, configurable) y se guardan en UTC.

> **Regla de honestidad:** si una herramienta no publica un dato, la tarjeta dice «sin dato» o «No disponible». Nunca un
> 0 % inventado ni un porcentaje calculado a partir de los tokens.

---

## Cómo funciona

```
 En TU PC
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  Claude Code ──(mod «ai-control-center-feed»)──► inbox\claude-mod-*.json     │
 │  Codex ────────(codex app-server, rollouts)────┐                              │
 │  Antigravity ──(agy /usage, conversaciones)────┤                              │
 │                                                ▼                              │
 │                         agente  ──►  SQLite (%LOCALAPPDATA%\ai-control-center)│
 │                                            │                                  │
 │                    panel web 127.0.0.1:4320 ◄┘──► extensión de VS Code (opc.) │
 └──────────────────────────────────────────────────────────────────────────────┘
```

- El **agente** es un proceso Node.js que cada 5 minutos consulta las fuentes oficiales y lee los archivos locales
  nuevos (de forma incremental: solo lo añadido). Guarda únicamente cifras en SQLite y sirve el panel web.
- El **mod de Claude Code** recibe de la propia Claude Code las cifras que muestra `/usage` y las deja en la bandeja del
  agente después de cada respuesta. Funciona también en el panel de Claude de VS Code.
- La **extensión de VS Code** es opcional. Lee la misma base y añade tarjetas, alertas y comandos dentro del editor.

**¿Por qué local y no en Docker o en un servidor?** Los datos solo existen en el PC donde usas las herramientas: las
sesiones iniciadas, los archivos de cada una y el mod. Por eso el proyecto **se descarga y se ejecuta en cada PC** que
quieras supervisar.

---

## Requisitos

| Requisito | Detalle |
|---|---|
| Sistema | Windows 10/11 (probado). macOS y Linux deberían funcionar, pero no están probados. |
| [Git](https://git-scm.com/) | para descargar el proyecto |
| [Node.js](https://nodejs.org/) **22 o superior** | ejecuta el agente; trae `node:sqlite`, así que no hace falta compilar nada nativo |
| Claude Code (`claude`) | con sesión iniciada, si quieres supervisar Claude |
| Codex CLI (`codex`) | con sesión iniciada (ChatGPT), si quieres supervisar Codex |
| Google Antigravity | instalado y con sesión, si quieres supervisar Gemini |
| VS Code **1.101 o superior** | solo si quieres la extensión |

`claude` y `codex` deben estar en el `PATH`. Compruébalo con `claude --version` y `codex --version`.

---

## Instalación en tu PC

Los comandos son de **PowerShell**. Repite estos pasos en cada PC que quieras supervisar.

### 1. Descargar y compilar

```powershell
git clone https://github.com/mtandazo35/ai-control-center.git
cd ai-control-center\apps\vscode-extension
npm install
npm run build
```

El repositorio es privado: `git clone` pide iniciar sesión en GitHub con una cuenta con acceso.
`npm run build` genera `dist\agent.js` (el agente) y `dist\extension.js` (la extensión).

### 2. Instalar el mod de Claude Code

Da la cuota de Claude **en vivo**, incluida la sesión de 5 h. Sin el mod, la sesión de 5 h sale como «sin dato» con una
hora de reinicio estimada.

```powershell
claude plugin marketplace add "C:\ruta\a\ai-control-center"
claude plugin install ai-control-center-feed@ai-control-center
```

Usa la ruta real donde clonaste el repositorio. Se instala para tu usuario y se carga en todas tus sesiones de Claude
Code, tanto en terminal como en el panel de VS Code. Compruébalo con `claude plugin list`: debe salir
`ai-control-center-feed … Status: ✔ enabled`. No modifica tu `settings.json` más allá de registrar el plugin.

### 3. Arrancar el agente con el panel web

Desde `ai-control-center\apps\vscode-extension`:

```powershell
node dist\agent.js --web
```

- La primera pasada lee tu historial y puede tardar unos segundos. Las siguientes son incrementales.
- El panel queda en `http://127.0.0.1:4320`. **La primera vez** ábrelo con la URL que incluye el token, guardada en
  `%LOCALAPPDATA%\ai-control-center\web-url.txt`:

  ```powershell
  Start-Process (Get-Content "$env:LOCALAPPDATA\ai-control-center\web-url.txt")
  ```

  El navegador recuerda el acceso durante 30 días, y desde entonces basta con `http://127.0.0.1:4320`.
- El agente sigue corriendo mientras esa ventana esté abierta. Se detiene con `Ctrl+C`.

### 4. (Opcional) La extensión de VS Code

```powershell
code --install-extension ..\..\release\ai-control-center-0.1.0.vsix
```

Recarga VS Code. Aparecen el ícono **AI Control Center** en la barra de actividad y el indicador `AI: …` en la barra de
estado.

### 5. (Opcional) Que el agente arranque solo con Windows

Desde VS Code, en la paleta de comandos: **«AI Control Center: Instalar agente residente»**. El agente queda en
`%LOCALAPPDATA%\ai-control-center\bin\agent.js` y se registra en `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
(clave `AIControlCenterAgent`), oculto y con el panel web incluido. Se quita con **«AI Control Center: Desinstalar
monitoreo»**. Cuando la extensión se actualiza, renueva esa copia al abrir VS Code, y el agente, al ver su archivo
cambiado, se reinicia solo con la versión nueva en menos de un minuto.

Sin la extensión, puedes dejar el paso 3 en una ventana abierta o crear una tarea programada que ejecute
`node <ruta>\dist\agent.js --web` al iniciar sesión.

---

## Comprobar que funciona

1. **El panel abre** en `http://127.0.0.1:4320` y muestra una tarjeta por herramienta detectada.
2. **Codex** muestra «Sesión (5 h)» y «Semanal (7 días)» con su porcentaje y su reinicio.
3. **Claude:** después de cualquier respuesta de Claude Code, existe un archivo
   `%LOCALAPPDATA%\ai-control-center\inbox\claude-mod-<sesión>.json`, y en menos de 5 minutos la tarjeta muestra la
   sesión de 5 h con la fuente «Claude Code (mod oficial, en vivo)».
4. **Una pasada de prueba en consola**, sin quedarse corriendo:

   ```powershell
   node dist\agent.js --once
   ```

   Muestra lo leído de cada fuente (`claude-default:transcripts`, `codex-default:quota`, `claude:mod`,
   `gemini-antigravity:runs`…) y el estado de cada conector (`ok: true` o el error).

---

## Uso diario

### Panel web

- **Arriba**, la recomendación «Qué uso ahora» y los filtros por proveedor.
- **Tarjetas por cuenta**, separando la «Cuota oficial» del «Consumo medido por la app».
- **Comparación por capacidad**, los gráficos de tokens y actividad (24 h, 7 d, 30 d), las sesiones de los últimos
  7 días y las alertas.
- Se actualiza solo cada 30 segundos. Es de **solo lectura**: las acciones están en la extensión.

### Extensión de VS Code

En la **barra de estado**, `AI: Claude 5h 19% · Codex 7d 12%` muestra la ventana más cargada de cada cuenta, solo con
datos oficiales vigentes. Haz clic para abrir el dashboard.

**Comandos** (`Ctrl+Shift+P` → «AI Control Center: …»):

| Comando | Qué hace |
|---|---|
| Dashboard | abre el panel dentro de VS Code |
| Abrir panel web (navegador) | abre el mismo panel en el navegador |
| Actualizar datos | recolecta ahora, sin esperar los 5 minutos |
| Detectar herramientas | lista versiones de CLIs y extensiones, y el producto Gemini exacto |
| Elegir siguiente cuenta | ranking con motivo; puede abrir una terminal o VS Code con ese perfil |
| Vincular perfil / Editar perfil / Probar conector | gestiona varias cuentas (ver más abajo) |
| Abrir terminal con perfil / Abrir perfil de VS Code | abre la herramienta con la carpeta de esa cuenta |
| Ver origen del dato | de dónde sale cada cifra, con su antigüedad y su fiabilidad |
| Registrar cuota manual | anota a mano un valor que veas en otra herramienta (queda marcado «manual») |
| Exportar (CSV/JSON) | exporta el historial; las rutas se reducen al nombre de la carpeta |
| Diagnóstico | versiones, base, recolectores, receptor OTLP y búsqueda de secretos en la base |
| Instalar agente residente | arranque automático con Windows (paso 5) |
| Claude: habilitar/revertir captura de cuota (statusLine) | alternativa al mod para sesiones de terminal; hace copia de respaldo de `settings.json` |
| Claude: habilitar/revertir telemetría OpenTelemetry local | tokens y coste de Claude por OTel (opcional) |
| Desinstalar monitoreo | revierte todo lo que la extensión haya tocado y detiene el agente |

---

## De dónde sale cada dato

| Herramienta | Cuota (porcentaje y reinicio) | Consumo | Frescura |
|---|---|---|---|
| **Claude Code** | **Mod `ai-control-center-feed`**: evento oficial `session.measure` (5 h y semanal). Respaldos: la caché de `/usage` que guarda Claude Code, los avisos «You've hit your limit · resets …» y una estimación de la hora de reinicio de la ventana de 5 h a partir de tu actividad | transcripts locales (solo los contadores `usage`); OTel opcional | en cada respuesta de Claude |
| **Codex** | `codex app-server` → `account/rateLimits/read`, con tu sesión, sin refrescar el token. Todos los buckets | rollouts locales (`token_count`) y `account/usage/read` | cada 5 min |
| **Antigravity** (Gemini) | `agy -p "/usage" --output-format json`: porcentaje restante y reinicio de la sesión de 5 h y la semanal de cada grupo de modelos (sin turno, sin gastar cuota). Si falla, queda el aviso del servidor en sus registros («Individual quota reached · Resets in …») | tokens y contexto por llamada (conversaciones locales), ejecuciones y minutos de actividad | cada 5 min |

Cada cifra lleva su **fuente**, su **hora de observación** y su **fiabilidad**. «Ver origen del dato» las muestra. Una
cuota con más de 30 minutos se marca como «dato hace X» y no cuenta para la recomendación.

Detalle técnico y cómo se verificó cada interfaz: [`docs/provider-capabilities.md`](docs/provider-capabilities.md).

---

## Configuración

### Extensión de VS Code (`Ajustes → AI Control Center`)

| Ajuste | Por defecto | Para qué |
|---|---|---|
| `aiControlCenter.timeZone` | `America/Guayaquil` | zona de las horas mostradas |
| `aiControlCenter.pollMinutes` | `5` | cada cuánto se recolecta |
| `aiControlCenter.staleMinutes` | `30` | a partir de cuándo un dato es «desactualizado» |
| `aiControlCenter.alertThresholds` | `[70, 85, 95]` | umbrales de alerta |
| `aiControlCenter.reservePercent` | `10` | por debajo de este % libre, una cuenta no se recomienda |
| `aiControlCenter.resetSoonMinutes` | `15` | aviso de reinicio próximo |
| `aiControlCenter.retentionDays` | `90` | días de historial |
| `aiControlCenter.webHost` / `webPort` | `127.0.0.1` / `4320` | dónde escucha el panel web |
| `aiControlCenter.dataDirectory` | vacío = `%LOCALAPPDATA%\ai-control-center` | carpeta de datos |
| `aiControlCenter.codexCommand` / `claudeCommand` | `codex` / `claude` | ruta de las CLIs si no están en el `PATH` |
| `aiControlCenter.notifications` | `true` | notificaciones de alertas |
| `aiControlCenter.otlpPort` | `4318` | receptor OTel local (solo si lo habilitas) |
| `aiControlCenter.demoMode` | `false` | datos **simulados**, rotulados como demo y nunca guardados |

### Agente (`node dist\agent.js …`)

| Opción | Por defecto | Para qué |
|---|---|---|
| `--web` | apagado | sirve el panel web |
| `--web-host <ip>` | `127.0.0.1` | `0.0.0.0` lo abre a tu red (por ejemplo, para el móvil); siempre exige el token |
| `--web-port <n>` | `4320` | puerto del panel |
| `--interval <min>` | `5` | cada cuánto recolecta |
| `--data-dir <carpeta>` | `%LOCALAPPDATA%\ai-control-center` | carpeta de datos |
| `--claude <ruta>` / `--codex <ruta>` | `claude` / `codex` | ruta de las CLIs |
| `--once` | — | una sola pasada con informe en consola, y termina |

El agente **no lee los ajustes de la extensión**: usa la zona America/Guayaquil, alertas 70/85/95, reserva del 10 % y
datos desactualizados a los 30 min.

> **Si cambias la carpeta de datos** (`dataDirectory` o `--data-dir`), define también la variable de entorno
> `AI_CONTROL_CENTER_DATA` con esa carpeta, para que el mod de Claude escriba en el mismo sitio. Sin ella, el mod usa
> `%LOCALAPPDATA%\ai-control-center`.

---

## Varias cuentas del mismo proveedor

Por defecto se supervisa la cuenta de la carpeta estándar de cada herramienta (`~\.claude`, `~\.codex`). Para añadir
otra cuenta de Claude o de Codex en el mismo PC, desde la extensión:

1. **«Vincular perfil»** → proveedor → alias → «Crear carpeta nueva» (por ejemplo `~\.codex-trabajo`).
2. **«Abrir terminal para iniciar sesión»**: abre una terminal con `CODEX_HOME` / `CLAUDE_CONFIG_DIR` apuntando a esa
   carpeta y deja escrito `codex login` / `claude auth login`. **Tú** inicias la sesión: nunca se copian credenciales.
3. **«Probar conector»**: verifica la cuenta y avisa si resulta ser la misma que otro perfil.

Un *perfil* de VS Code no separa las sesiones: lo que separa cuentas es la carpeta de configuración de cada herramienta.

---

## Archivos que crea en tu PC

Todo en `%LOCALAPPDATA%\ai-control-center\`:

| Archivo / carpeta | Contenido |
|---|---|
| `ai-control-center.sqlite` | historial: cuotas, tokens, sesiones, alertas y auditoría (solo cifras) |
| `inbox\claude-mod-*.json` | lo que deja el mod de Claude (uno por sesión) |
| `inbox\claude-statusline.jsonl` | solo si usas la captura por statusLine |
| `web-token` | token de acceso al panel web; si lo borras, se revocan todos los accesos |
| `web-url.txt` | URL del panel con el token, para abrirlo la primera vez |
| `agent.log` / `agent.pid` | registro y PID del agente |
| `bin\` | agente residente y scripts auxiliares, si los instalas |
| `backups\` | copias de tu `settings.json` de Claude antes de cualquier cambio de la extensión |

---

## Privacidad y seguridad

- **Nada sale de tu PC.** No hay telemetría propia. El panel web escucha solo en `127.0.0.1`, salvo que tú lo cambies.
- **No se leen credenciales:** ni `auth.json`, ni `.credentials.json`, ni `oauth_creds.json`, ni llaveros. La identidad
  sale de las herramientas oficiales y se guarda **enmascarada** (`p***a@dominio`), con el ID de la cuenta solo como
  hash.
- **No se guarda contenido:** de los transcripts y registros solo se extraen contadores, modelo, sesión y el nombre de la
  carpeta del proyecto. Nunca prompts, respuestas ni rutas completas.
- **Panel web:** token obligatorio que se cambia por una cookie HttpOnly y SameSite=Strict, solo lectura (GET), CSP
  estricta y protección contra DNS rebinding.
- **Cambios en tu configuración** (statusLine u OTel de Claude): solo con tu confirmación, con copia de respaldo previa y
  reversibles.

Más detalle en [`docs/privacy.md`](docs/privacy.md).

---

## Solución de problemas

| Síntoma | Causa y solución |
|---|---|
| Claude «Sesión (5 h): sin dato · Se reinicia … (estimado)» | El mod no está instalado o todavía no hubo respuesta. Comprueba `claude plugin list` y envía cualquier mensaje a Claude. |
| El mod está instalado pero no aparece `claude-mod-*.json` | El mod solo escribe si existe la carpeta `inbox`, que crea el agente: arráncalo una vez. Si cambiaste la carpeta de datos, define `AI_CONTROL_CENTER_DATA`. |
| Claude semanal con «dato hace X horas» | Es el respaldo de la caché de `/usage`. Con el mod activo se actualiza en cada respuesta. |
| El panel no abre (`127.0.0.1:4320` rechaza la conexión) | El agente no está corriendo: `node dist\agent.js --web`. |
| `panel web no iniciado: EADDRINUSE` en `agent.log` | Ya hay otro agente usando el puerto. Ciérralo (`Get-CimInstance Win32_Process -Filter "Name='node.exe'"` y busca `agent.js`) o usa `--web-port`. |
| «Falta el token» / error 401 | Abre la URL de `web-url.txt` una vez para crear la cookie. |
| Codex con error o «sin sesión» | Ejecuta `codex login`. Comprueba que `codex app-server --help` funciona desde PowerShell. |
| Gemini «Cuota individual 100 %» | Antigravity avisó que la cuota se agotó. La tarjeta muestra la hora de reinicio que dio el servidor. |
| Gemini sin barras de 5 h y semanal | `agy -p "/usage" --output-format json` falló o agy no está en `~/.gemini/bin` ni en el PATH. Pruébalo en PowerShell (en Git Bash, `/usage` se convierte en una ruta: usa `MSYS_NO_PATHCONV=1`). Ruta propia: variable `AGY_PATH`. |
| Gemini «plan desconocido» | Antigravity no informa el plan. Decláralo en «Editar perfil → Plan declarado». |
| Horas que no cuadran | Revisa `aiControlCenter.timeZone`. El agente usa America/Guayaquil. |

---

## Actualizar y desinstalar

**Actualizar:**

```powershell
cd ai-control-center
git pull
cd apps\vscode-extension
npm install
npm run build
```

Si usas la extensión, reinstala el `.vsix` de `release\`: al abrir VS Code renueva la copia del agente residente y este
se reinicia solo. Un agente lanzado a mano con `node distgent.js` también se reinicia solo al ver el `agent.js` nuevo.

**Desinstalar:**

1. Extensión: **«Desinstalar monitoreo»** (revierte statusLine/OTel, quita el arranque automático y detiene el agente);
   después desinstala la extensión. Sin la extensión, detén el agente con `Ctrl+C`.
2. Mod: `claude plugin uninstall ai-control-center-feed` y `claude plugin marketplace remove ai-control-center`.
3. Datos, si quieres borrar el historial: elimina `%LOCALAPPDATA%\ai-control-center`.

---

## Desarrollo

```
ai-control-center/
├─ apps/vscode-extension/      extensión + agente (TypeScript)
│  ├─ src/adapters/            Codex, Claude (mod, caché, transcripts, statusLine, OTel), Antigravity, detección
│  ├─ src/core/                SQLite, recomendación, alertas, modelo de vista
│  ├─ src/collector.ts         ciclo de recolección (compartido por extensión y agente)
│  ├─ src/agent.ts · web.ts    agente y panel web
│  ├─ media/                   dashboard (HTML/JS/CSS sin framework)
│  └─ test/ · test-host/       pruebas vitest y prueba de humo en un VS Code real
├─ apps/claude-mod/            mod de Claude Code «ai-control-center-feed»
├─ .claude-plugin/             marketplace local del mod
├─ docs/                       capacidades, arquitectura, instalación, privacidad
└─ release/                    .vsix compilado
```

```powershell
cd apps\vscode-extension
npm install
npm run check      # typecheck + lint + 74 pruebas + empaquetado del .vsix
npm run test:host  # prueba de humo en un VS Code real con perfil aislado
npm run watch      # recompila al guardar
```

Las pruebas usan **solo datos inventados** (fechas de 2030, identificadores genéricos). Nunca se suben datos reales de
una cuenta.

Para depurar la extensión, abre `apps\vscode-extension` en VS Code y pulsa `F5`. Para validar el mod:
`claude plugin validate apps\claude-mod`.

---

## Próximos pasos

- **Panel central en una VPS (Docker):** API + PostgreSQL + la misma web con **login de usuario**, donde cada PC envía sus
  cifras con su propio token. Así se ven todas las cuentas de todos tus equipos en un solo sitio, también desde el
  móvil. El recolector seguirá corriendo en cada PC. Ver «Qué corre dónde» en
  [`docs/architecture.md`](docs/architecture.md).
- Probar en macOS: el instalador del agente residente solo existe para Windows.

## Licencia

[MIT](LICENSE) © 2026 mtandazo35
