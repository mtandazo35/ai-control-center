# Privacidad y seguridad

- **Datos solo locales.** No hay telemetría propia ni conexiones salientes. El único puerto que se abre es el receptor
  OTLP en `127.0.0.1`, y solo si lo habilitas.
- **Credenciales.** Nunca se leen `auth.json`, `.credentials.json`, `oauth_creds.json`, llaveros ni cookies. La
  identidad sale de `claude auth status` y de `account/read`. Se guarda el correo enmascarado (`m***6@dominio`) y el
  hash SHA-256 del id de cuenta u organización.
- **Contenido.** De los transcripts y rollouts solo se extraen contadores de tokens, el modelo, el id de sesión, la hora
  y el nombre de la carpeta del proyecto. Un filtro previo descarta sin parsear las líneas de prompts y herramientas.
  El receptor OTLP descarta `/v1/logs` y `/v1/traces`.
- **statusLine.** El envoltorio guarda `rate_limits`, el id de sesión, el modelo, el nombre de la carpeta, la versión
  y el costo estimado. No guarda `transcript_path` ni ningún texto.
- **Cambios de configuración.** Solo con confirmación modal, con respaldo previo y reversibles. Cada uno queda en
  `audit_logs`.
- **Webview.** CSP `default-src 'none'`, script con nonce, DOM construido con `textContent` y una lista blanca de
  comandos que el webview puede pedir.
- **Autocomprobación.** `Diagnóstico` recorre la base buscando JWT, claves `sk-`, `*_token` y correos completos, y la
  suite de pruebas hace lo mismo con todas las tablas tras el escenario de extremo a extremo.
