# Instalación, uso y reversión

## Instalar el `.vsix`

1. VS Code → vista Extensiones → menú `…` → **Install from VSIX…** → `release/ai-control-center-0.1.0.vsix`.
   También por terminal: `code --install-extension release/ai-control-center-0.1.0.vsix`
2. Recarga la ventana. Aparece el ícono **AI Control Center** en la Activity Bar y el indicador `AI: …` en la Status Bar.
3. Al arrancar, la extensión detecta las herramientas, crea un perfil por herramienta instalada (`claude-default`,
   `codex-default`, `gemini-antigravity`), verifica las sesiones con las herramientas oficiales y lee la cuota de Codex.

Requisitos: VS Code ≥ 1.101 (trae `node:sqlite`). Para leer cuotas hacen falta `codex` y `claude` en el PATH, o en las
rutas que indiquen `aiControlCenter.codexCommand` y `aiControlCenter.claudeCommand`. `node` en el PATH solo hace falta
para la captura statusLine y para el agente.

## Cuota de Claude en vivo: mod «ai-control-center-feed» (recomendado)

Es un mod de Claude Code que escucha el evento oficial `session.measure` y deja en `%LOCALAPPDATA%\ai-control-center\inbox\`
la sesión de 5 h, la semanal, el % de contexto y el coste. Funciona también en el panel de Claude de VS Code y **no toca tu
`settings.json`**. Instalación desde una terminal, apuntando a la carpeta del repo:

```
claude plugin marketplace add <ruta>\ai-control-center
claude plugin install ai-control-center-feed@ai-control-center
```

Escribe solo si existe la carpeta `inbox` (la crean la extensión o el agente). Para quitarlo: `claude plugin uninstall ai-control-center-feed`.

## Habilitar la cuota de Claude con statusLine (alternativa)

`AI Control Center: Claude: habilitar captura de cuota (statusLine)`:

- Hace una copia de `<CLAUDE_CONFIG_DIR>/settings.json` en `%LOCALAPPDATA%\ai-control-center\backups\`.
- Cambia `statusLine.command` por un envoltorio que guarda `rate_limits` y **después ejecuta tu statusLine anterior con
  la misma entrada**, así que tu barra no cambia. Si no tenías statusLine, muestra `Modelo · 5h N% · 7d N%`.
- Los porcentajes aparecen tras la primera respuesta de una sesión `claude` en **terminal**.
- Para deshacerlo: `Claude: revertir captura de cuota (statusLine)`. Solo restaura si tu statusLine sigue siendo la
  instalada. Si la cambiaste después, no toca nada y te indica el respaldo.

## Telemetría local de Claude (opcional)

`Claude: habilitar telemetría OpenTelemetry local` añade al bloque `env` de `settings.json` la variable
`CLAUDE_CODE_ENABLE_TELEMETRY=1` y las variables `OTEL_EXPORTER_OTLP_METRICS_*`, que apuntan a `127.0.0.1:4318`.
Es solo para métricas: no se activan logs ni prompts. Se niega a seguir si ya tienes telemetría propia, y se deshace
con `Claude: revertir telemetría…`.

## Segunda cuenta del mismo proveedor

1. `Vincular perfil` → proveedor → alias → **Crear carpeta nueva** (p. ej. `~/.codex-trabajo`).
   Opcional: entorno de VS Code separado.
2. `Abrir terminal para iniciar sesión`: abre una terminal con `CODEX_HOME`/`CLAUDE_CONFIG_DIR` y deja escrito
   `codex login` / `claude auth login` sin ejecutarlo. **Tú** inicias la sesión.
3. `Probar conector`: verifica la identidad. Si resulta la misma cuenta que otro perfil, lo avisa
   («perfiles no aislados»).
4. `Elegir siguiente cuenta` → abre una terminal con ese perfil, o una ventana de VS Code con su propio
   `--user-data-dir` y la variable puesta. Un *Profile* de VS Code **no** aísla la sesión OAuth.

## Agente residente (opcional, Windows)

`Instalar agente residente` copia `agent.js` en `%LOCALAPPDATA%\ai-control-center\bin\` y añade
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\AIControlCenterAgent`, que lo lanza oculto con `wscript`.
Usa la misma base y el mismo lease que la extensión. Si un proceso que tenía el lease ya no existe (cerrado a la
fuerza), el siguiente lo toma al momento en vez de esperar a que caduque. El agente revisa cada minuto si su
`agent.js` cambió y, si es así, arranca la versión nueva y sale; la extensión renueva la copia instalada al activarse.
Manual (cualquier SO): `node dist/agent.js --data-dir <carpeta> --interval 5`. Para una pasada única: `--once`.

## Panel web local (navegador)

Muestra el mismo dashboard en el navegador, en vivo (se refresca cada 30 s) y en **solo lectura**: no hay acciones.

- Desde VS Code: `AI Control Center: Abrir panel web (navegador)`.
- Sin VS Code: `node dist/agent.js --web` (el agente instalado ya lo lleva). La URL queda en
  `%LOCALAPPDATA%\ai-control-center\web-url.txt`.
- Escucha en `127.0.0.1:4320` por defecto (`aiControlCenter.webHost` / `webPort`, o `--web-host` / `--web-port`).
  Para abrirlo desde el móvil en la misma red, usa `0.0.0.0` (pide confirmación) y abre `http://<IP-del-PC>:4320/?token=…`.
- Siempre exige el token de `%LOCALAPPDATA%\ai-control-center\web-token`. La primera visita con `?token=` lo cambia
  por una cookie HttpOnly y SameSite=Strict y lo quita de la URL. Para revocar todos los accesos, borra `web-token`.
- En `127.0.0.1` se rechaza cualquier cabecera Host ajena (protección contra DNS rebinding). Solo se admite GET, y la
  CSP es estricta.
- **Pendiente**: llevarlo a una VPS local, detrás de TLS (Caddy/NPM) y con el agente enviando los datos, sin exponer
  el puerto en claro.

## Desinstalar

1. `AI Control Center: Desinstalar monitoreo`: revierte la captura statusLine y OTel de cada perfil, quita la entrada
   del agente, lo detiene y apaga el receptor OTLP. El informe sale en el canal de salida *AI Control Center*.
2. Desinstala la extensión desde la vista Extensiones.
3. Opcional: borra `%LOCALAPPDATA%\ai-control-center` (historial, respaldos y bandeja).

## Desarrollo

```bash
cd apps/vscode-extension
npm install
npm run check        # typecheck + lint + vitest + .vsix
npm run test:host    # prueba de humo dentro de un VS Code real (perfil aislado)
```

Para el Extension Development Host, abre `apps/vscode-extension` en VS Code y pulsa F5, o ejecuta
`code --extensionDevelopmentPath=apps/vscode-extension`.

## Comandos para configurar y auditar

| Comando | Para qué |
|---|---|
| Detectar herramientas | versiones de CLI y extensiones, y producto Gemini exacto |
| Probar conector | verifica la sesión con la herramienta oficial |
| Ver origen del dato | fuente, antigüedad, confianza y método de cada valor |
| Diagnóstico | versiones, base, perfiles, recolectores, latidos, receptor OTLP, búsqueda de secretos en la base y auditoría |
| Exportar | JSON (todas las tablas) o CSV (una tabla). Las rutas se reducen al nombre de la carpeta |
| Registrar cuota manual | dato etiquetado «manual» (p. ej. para Antigravity) |
