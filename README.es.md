[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [Español](README.es.md)

# ADHDev

**El plano de control para tus agentes de programación: todos los agentes de todas las máquinas en una sola vista, una cola de tareas compartida, y solo el trabajo que pasa tus pruebas llega a `main`.**

[![GitHub stars](https://img.shields.io/github/stars/vilmire/adhdev?style=social)](https://github.com/vilmire/adhdev/stargazers)
[![npm](https://img.shields.io/npm/v/adhdev?label=npm%20i%20-g%20adhdev)](https://www.npmjs.com/package/adhdev)
[![npm standalone](https://img.shields.io/npm/v/@adhdev/daemon-standalone?label=%40adhdev%2Fdaemon-standalone)](https://www.npmjs.com/package/@adhdev/daemon-standalone)
[![CI](https://github.com/vilmire/adhdev/actions/workflows/ci.yml/badge.svg)](https://github.com/vilmire/adhdev/actions)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

Los agentes de programación con IA se han convertido en trabajadores de segundo plano de larga duración. ADHDev es el plano de control para ellos: lanza, observa, aprueba y dirige sesiones de agentes desde un panel web o móvil — Claude Code, Codex, Kimi, Cursor CLI, Antigravity CLI, Grok CLI y OpenCode lado a lado, en todas las máquinas que tengas — y deja la convergencia en manos de un pipeline desatendido que fusiona el trabajo terminado en `main`.

**Agentes en paralelo sin colisiones.** Cada tarea se ejecuta en su propio git worktree; el Refinery filtra, verifica y rebasa el trabajo terminado sobre main, y solo fusiona si main no se ha movido — sin resaca de día de fusión.

Sitio web: **[adhf.dev](https://adhf.dev)** · Documentación: **[docs.adhf.dev](https://docs.adhf.dev)**

**Pruébalo con un solo comando:** `npx @adhdev/daemon-standalone`, y abre http://localhost:3847.

<p align="center">
  <img src="docs/assets/readme/landing-command-center-demo-poster.jpg" alt="Panel de escritorio de ADHDev: un coordinador de mesh responde con una tabla de estado mientras un trabajador de Claude Code y otro de Codex construyen dos funciones en paralelo" width="100%" />
</p>

**El ciclo:** describes una tarea en el chat → el coordinador la registra, la etiqueta y la encola → una máquina libre la toma en un worktree nuevo → deciden las pruebas propias de tu repositorio → se rebasa sobre `main` y se fusiona solo si `main` no se ha movido, y el worktree desaparece. Tu teléfono solo vibró si algo necesitaba aprobación.

ADHDev se construye así. En el monorepo privado donde se desarrolla ADHDev — este motor se publica desde él como submódulo — aproximadamente uno de cada seis commits de `main` es un commit `Auto-merge via Refinery`: trabajo que un agente terminó, que las pruebas propias del repositorio aprobaron y que el Refinery integró sin que una persona ejecutara `git merge`. Ese historial vive en el monorepo upstream, así que el registro de este espejo público no mostrará esos commits de fusión.

---

## Por qué ADHDev

### 🕸️ Repo Mesh — paralelismo real entre varias máquinas
(Un mesh de una sola máquina se ejecuta totalmente en local; extenderlo a varias máquinas requiere la edición cloud.) Encola tareas con dependencias y deja que un coordinador las despache a cualquier nodo con capacidad libre — tu portátil, un equipo de sobremesa, una máquina de compilación. Es orquestación real entre varias máquinas sobre un mesh P2P, **no** SSH a un único host. Cada tarea se ejecuta en su propio worktree, así que los agentes nunca se pisan. El motor de mesh y Refinery se incluye en este repositorio; el despacho entre máquinas funciona en la edición cloud.

Un mesh está vinculado a un repositorio git y se encarga de las piezas móviles que de otro modo coordinarías a mano:

| | |
| --- | --- |
| **Cola de tareas** | Basada en extracción (pull). `pending → assigned → completed/failed`, con orden por `depends_on` y reintentos. Los nodos libres reclaman el trabajo por sí mismos — no hay un planificador push que se desincronice. |
| **Misiones** | Un objetivo que agrupa muchas tareas, de modo que un coordinador reiniciado retoma donde lo dejó el anterior en lugar de reencolarlo todo. |
| **Nodos worktree** | Un checkout de rama aislado por tarea paralela, preparado automáticamente (instalación, recompilaciones nativas, salidas de compilación ignoradas por git) antes de despacharle ningún trabajo. |
| **Libro mayor solo de adición** | Cada despacho, finalización, fallo, bloqueo y punto de control como un registro solo de adición en el almacén SQLite local del mesh — la pista de auditoría que permite responder “qué pasó realmente” después de los hechos. |
| **Notas operativas** | Las lecciones registradas en tiempo de ejecución (una rareza de un proveedor, un procedimiento de recuperación) se inyectan en cada futuro prompt del coordinador, de modo que el conocimiento sobrevive a la sesión que lo aprendió. |
| **Prompt con estado en vivo** | El prompt de sistema del coordinador no es texto estático — al lanzarse es una representación del estado en vivo del mesh (salud de los nodos, misión activa, fallos recientes, notas acumuladas), y en tiempo de ejecución se inyectan eventos en su sesión en lugar de que haga polling. |
| **Enrutamiento por dificultad + cuota** | Etiqueta una tarea como easy / medium / difficult y la ranura del nodo para ese nivel (proveedor, modelo, nivel de razonamiento, tope paralelo) se encarga de ella, de modo que el trabajo rutinario corre en modelos baratos y solo las tareas difíciles recurren a los caros. Cada máquina también lee la ventana restante de 5 horas y semanal de cada suscripción de CLI: un plan casi agotado se omite (la tarea espera o pasa al siguiente proveedor del nodo), y entre el resto se gasta primero la cuota que caducaría sin usar en el próximo reinicio. Puedes ver la previsión de enrutamiento por dificultad en el panel antes de que se ejecute nada. |
| **Encadenado de tareas** | Encadena tareas con `depends_on`: una tarea dependiente espera a que sus predecesoras terminen y luego recibe sus resúmenes de finalización como un apéndice “Upstream results”. Una predecesora fallida o cancelada retiene (o, según la política del mesh, cancela) la cadena descendente y avisa al coordinador. `mesh_enqueue_batch` encola varias tareas ya confirmadas en una sola llamada atómica. |

<p align="center">
  <img src="docs/assets/readme/landing-mesh-observability.jpg" alt="Resumen del mesh de ADHDev: una misión activa, dos tareas en ejecución en la cola, y el checkout main más dos nodos worktree en línea" width="100%" />
</p>

### 📊 Enrutamiento consciente de la cuota — gasta las suscripciones que ya pagas
Cada máquina lee cuánto queda de la ventana de 5 horas y semanal de cada suscripción de CLI. Cuando se reclama una tarea, un plan casi agotado se omite (la tarea espera o pasa al siguiente CLI de esa máquina), y entre el resto se gasta primero la cuota que caducaría sin usar en el próximo reinicio. La página Máquinas muestra toda la flota en una sola cuadrícula, y la pestaña Tasks del mesh prevé qué ranura se hará cargo de la siguiente tarea en cada nivel de dificultad antes de que se ejecute nada.

<p align="center">
  <img src="docs/assets/readme/fleet-quota.png" alt="Cuota del plan en todas las máquinas: cuatro máquinas por siete CLI (Antigravity, Claude Code, Codex, Cursor, Grok, Kimi, OpenCode) con indicadores de uso de 5 horas y semanal" width="100%" />
</p>
<p align="center">
  <img src="docs/assets/readme/route-forecast.png" alt="Previsión de enrutamiento para una tarea medium: codex-cli es el siguiente, las ranuras sonnet y opus de Claude Code están listas, con capacidad paralela libre por ranura" width="70%" />
</p>

### 🚢 Refinery — integración desatendida en `main`
El paralelismo solo compensa si el trabajo realmente se fusiona. El Refinery hace converger las tareas terminadas con puertas de validación por repositorio, comprobaciones de equivalencia de parches, rebase y fusión con soporte de submódulos (solo si main no se ha movido) y limpieza automática de worktrees — de forma desatendida. Los agentes terminan; el Refinery los integra. El tablero del mesh de arriba muestra el pipeline en vivo: tareas avanzando por la cola, trabajos de refine mientras la convergencia está en curso, y cada despacho, finalización y bloqueo en el feed de actividad.

### 🧩 Convergencia con soporte de submódulos — funciona en monorepos reales
Los worktrees paralelos y las fusiones desatendidas se vuelven frágiles en cuanto aparecen los submódulos de git. ADHDev aborda ese caso de frente — este mismo proyecto es un monorepo con submódulos (un repositorio raíz más el motor AGPL y el catálogo de proveedores como submódulos), y usamos el mesh y el Refinery sobre él todos los días. El Refinery trata los submódulos como ciudadanos de primera durante la convergencia:

- **Puerta de alcanzabilidad** — antes de que una rama raíz llegue a `main`, verifica que los commits de submódulo referenciados sean alcanzables desde el `origin/main` del submódulo; si no, la tarea se retiene como bloqueada hasta que esos commits se publiquen.
- **Detección de equivalencia de parches** — cuando un commit de submódulo se rebasa o se aplasta (squash) y su SHA cambia, el Refinery sigue determinando si el *contenido* ya se integró, de modo que no fusiona dos veces ni señala por error una divergencia.
- **Actualizaciones atómicas de puntero** — la actualización del puntero del submódulo converge junto con el cambio raíz, así que una fusión desatendida nunca deja la raíz apuntando a un commit de submódulo roto o colgante.

### ⚡ Asíncrono por diseño — hablas con un solo lugar
Hablas con un solo lugar. El coordinador orquesta de forma asíncrona a cada trabajador y cada máquina — él espera eventos, tú no. Sin vigilar sesiones. En lugar de sentarte frente a la ventana de cada agente esperando a que termine, entregas el trabajo a un único coordinador que dirige a todos los trabajadores en paralelo y reacciona solo cuando llega de verdad un evento de finalización, aprobación o estado — sin polling, sin esperas bloqueantes. Una sola conversación para ti; un bucle de eventos no bloqueante por debajo.

### 🌐 Ve y dirige cada sesión
Tus agentes se ejecutan en local; tú los observas y los manejas desde cualquier navegador. El panel es una superficie de control real: inspecciona las sesiones activas, lee el estado del chat y del terminal, aprueba o interrumpe el trabajo, reabre el historial correcto y envía la siguiente instrucción desde un navegador o tu teléfono. Sin vigilar terminales. Las notificaciones push de aprobación incluyen el comienzo del propio comando, porque aprobar `rm -rf build/` y aprobar `git push --force` merecen tiempos de reacción distintos: llega la notificación push → la tocas → apruebas con un toque (las notificaciones push al teléfono vienen con la edición cloud).

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="docs/assets/readme/landing-desktop-detail.jpg" alt="Panel de escritorio de ADHDev en modo oscuro: el chat del coordinador junto a dos sesiones de trabajadores, cada una en su propia rama de git worktree" width="100%" />
    </td>
    <td width="50%" align="center" valign="top">
      <img src="docs/assets/readme/landing-mobile-notification-demo-poster.jpg" alt="Banner de aprobación de ADHDev en un teléfono que muestra el comando rm -rf exacto que Claude Code quiere ejecutar, con Yes / always allow / No" width="100%" />
    </td>
  </tr>
</table>

Las sesiones también pueden poner archivos en el chat como **artefactos** — Markdown, imágenes, diffs, JSON y texto del espacio de trabajo, con vista previa en línea y que se abren, copian o descargan bajo demanda. Los archivos nunca salen del espacio de trabajo registrado.

### 🛡️ Aprobaciones que se mantienen acotadas
- **La aprobación automática solo pulsa la opción de una sola vez.** Con la aprobación automática activada, el daemon responde al aviso de permiso de un trabajador con un único “yes” — nunca “always”, “don't ask again” ni una concesión a nivel de sesión o de proyecto.
- **Los botones del propio agente, en la Bandeja.** Una solicitud pendiente muestra las opciones reales del proveedor, las más acotadas primero, con las concesiones permanentes al final y marcadas.
- **Los trabajadores delegados preguntan primero a su coordinador.** La solicitud de permiso de un trabajador va al coordinador; recibes la notificación push solo si sigue sin respuesta pasado un minuto.
- **Solo cuenta un aviso activo.** El texto de aprobación que un agente simplemente imprime, cita o que ya se desplazó fuera de pantalla nunca se toma por un aviso real, y una elección para una solicitud que ha cambiado entretanto se rechaza en lugar de responderse.

### 🧑‍💼 Un asistente que sigue tus proyectos
Inicia un asistente desde el panel y dale los proyectos que te importan. Te transmite los informes y avisos de cada proyecto, resume una vez al día qué terminó, qué está bloqueado y qué necesita de ti (a las 09:00 hora local por defecto), y señala las misiones que llevan tres días en silencio. Cuando necesita una decisión, ofrece algunas opciones como botones que puedes tocar; cada acción que realiza en tu nombre espera tu elección. Funciona con cualquier CLI de asistente, recuerda tus últimas solicitudes tras los reinicios y — una vez que lo permites en la otra máquina — puede seguir un proyecto alojado en otra de tus máquinas sin tener que hacer checkout en local.

### 🔺 Revisión desde varias perspectivas
Para una investigación de solo lectura que importa — un RCA de un bug, una revisión de diseño, una auditoría — pide una segunda opinión al coordinador: envía la misma pregunta a 2–3 trabajadores de proveedores distintos, espera sus informes y presenta dónde coinciden, dónde discrepan y qué afirmaciones hizo solo uno de ellos. Un acuerdo alto no es lo mismo que tener razón — el mismo modelo con el mismo contexto repite el mismo error — así que las discrepancias son la parte que vale la pena leer.

### 🔐 Transporte P2P (confianza, no un muro de pago)
El chat, los comandos, las capturas de pantalla y la entrada remota viajan por un canal de datos WebRTC cifrado directamente entre tu panel y tu daemon. El servidor se ocupa del inicio de sesión, la señalización y metadatos ligeros, más una excepción deliberada: en la edición cloud recibe el aviso de aprobación (el comando y las etiquetas de los botones) para construir la notificación push, y la notificación muestra hasta 80 caracteres de él. El chat, la salida del terminal y tu código no residen en el equipo de otra persona. Es una propiedad de confianza del diseño, no una venta adicional.

Cuando una red obliga a que la conexión del panel pase por un relé TURN, ADHDev sigue buscando un camino directo en segundo plano y solo cambia cuando el nuevo camino está verificado y el panel se ha movido a él, de modo que el cambio no corta la sesión.

### 📁 Mueve un proyecto entre tus propias máquinas (edición cloud)
Envía una carpeta de proyecto de una de tus máquinas a otra por una conexión directa dedicada. Los bytes de los archivos nunca pasan por el servidor cloud ni por un relé. Ambas máquinas confirman la misma lista de archivos, los secretos (`.env*`, claves, credenciales cloud, historial de shell y similares) se dejan siempre fuera, y los archivos aterrizan en una carpeta nueva dentro de un proyecto registrado solo después de que cada byte esté verificado; nada existente se sobrescribe.

### 🧪 Deja que los trabajadores manejen un navegador
Los trabajadores pueden manejar un navegador local mediante un driver Playwright MCP para comprobar la interfaz que acaban de construir. Un driver necesita aprobación antes de activarse (los paquetes de confianza y bajo riesgo pueden aprobarse automáticamente), y cada llamada se comprueba con las credenciales del propio trabajador.

<p align="center">
  <img src="docs/assets/readme/landing-mobile-resume-demo-poster.jpg" alt="ADHDev en un teléfono: leyendo la respuesta de un agente y escribiéndole la siguiente instrucción" width="320" />
</p>

---

## Cómo se compara

- **Claude Code Remote Control, Codex Remote:** excelentes para manejar desde el teléfono la sesión de un solo proveedor. ADHDev añade una cola que comparten varios proveedores y máquinas, enrutamiento consciente de la cuota entre ellos y fusiones condicionadas por pruebas. Si ejecutas un solo CLI en una sola máquina, las funciones remotas integradas pueden ser todo lo que necesitas.
- **Paseo, Happy:** control remoto de código abierto y apps móviles para agentes de programación. El enfoque de ADHDev es el trabajo posterior al prompt: las máquinas libres extraen tareas, cada una en su propio worktree, y solo el trabajo que pasa tus pruebas llega a `main`.
- **Conductor, Superset, Vibe Kanban:** agentes en paralelo en worktrees, que terminan en un diff o un PR que tú revisas y fusionas. ADHDev ejecuta una cola de la que extraen tus máquinas Mac, Windows y Linux, y fusiona por ti cuando pasan las puertas.

## Cómo funciona

ADHDev no sustituye a tus agentes ni crea los suyos — **se conecta a los que ya están instalados en tu máquina** y les da una superficie de control.

```
   browser / phone
         │  chat, commands, screenshots, remote input
         ▼
   ┌───────────────┐        PTY          ┌──────────────────────┐
   │    daemon     │────────────────────▶│ Claude Code, Codex,  │
   │ (your machine)│◀────────────────────│ Cursor CLI, …        │
   │               │        CDP          ├──────────────────────┤
   │  · providers  │────────────────────▶│ Cursor, VS Code,     │
   │  · sessions   │                     │ Antigravity, …       │
   │  · mesh/queue │                     └──────────────────────┘
   │  · Refinery   │
   └───────────────┘
         │
         └── git worktrees ── one isolated checkout per parallel task
```

- **El daemon es dueño de las integraciones.** Tres categorías de proveedor: `cli` (PTY), `ide` (Chrome DevTools Protocol), `extension` (CDP webview).
- **Los runtimes de larga duración son un proceso aparte.** `adhdev-sessiond` es dueño de los PTY, así que tus sesiones de CLI sobreviven a un reinicio o actualización del daemon.
- **La edición autoalojada habla directamente con el daemon** mediante HTTP + WebSocket en `localhost:3847`. En la edición cloud, los mismos datos viajan por un canal de datos WebRTC entre el navegador y el daemon, y el servidor solo hace la señalización.

### Qué ocurre cuando encolas una tarea

```
mesh_enqueue_task  →  SQLite queue (pending)
                   →  an idle node claims it (assigned)
                   →  worker agent runs in its own git worktree
                   →  completed / failed  →  append-only ledger
                   →  Refinery: repo's own gates → patch equivalence → rebase → merge (main unchanged) → cleanup
```

Cuatro propiedades que dan forma a todo lo demás:

1. **El coordinador enruta, no implementa.** Orquesta herramientas del mesh en lugar de leer y editar código él mismo, así que su contexto se mantiene pequeño y su titularidad sobrevive a los reinicios del daemon.
2. **Nada hace polling.** Las finalizaciones de trabajadores, las aprobaciones y los informes de refine se entregan directamente en la sesión del coordinador a medida que ocurren — mediante una llamada estructurada `report_completion`, no leyendo la pantalla. Esperas eventos; no preguntas por el estado en un bucle.
3. **Git es la prueba, no la palabra del agente.** “Hecho” se verifica con el estado real de git y puntos de control de commits, no con un trabajador que afirma haber tenido éxito.
4. **La ambigüedad detiene el pipeline.** El Refinery nunca hace force-push; todo lo que no puede decidir se retiene para una persona en lugar de fusionarse.

> En profundidad: [Guía para desarrolladores de Repo Mesh](docs/repo-mesh/DEVELOPER.md) · [session-host](docs/self-hosted/session-host.md)

---

## Instalación

**Requisitos:** Node.js 20 o superior (se recomienda 22 LTS; en Windows usa 22.x — consulta la nota más abajo), git, y al menos un agente de programación ya instalado y autenticado — ADHDev maneja los CLI que ya usas.

**Recomendado — el CLI `adhdev`:**

```bash
npm install -g adhdev
adhdev standalone
```

Abre **`http://localhost:3847`**.

**Autoalojar directamente con el paquete standalone:**

```bash
npm install -g @adhdev/daemon-standalone
adhdev-standalone
```

Todo se ejecuta en tu máquina como un daemon local con un panel integrado — no se necesita cuenta cloud para la ruta standalone. Ambos paquetes instalan un comando `adhdev`, así que instala uno u otro, no ambos.

**Edición cloud (varias máquinas, notificaciones push):**

```bash
curl -fsSL https://adhf.dev/install | sh      # macOS / Linux
irm https://adhf.dev/install.ps1 | iex         # Windows (PowerShell)
brew tap vilmire/adhdev && brew install adhdev # macOS / Linux con Homebrew (incluye Node.js)
adhdev setup                                   # inicia sesión y abre https://adhf.dev
```

Opciones útiles:

```bash
adhdev standalone --host 0.0.0.0  # permite otros dispositivos de la misma LAN
adhdev standalone --port 8080     # puerto personalizado
adhdev standalone --token mysecret # autenticación por token para scripts / acceso de operador
adhdev standalone --no-open       # no abre el navegador automáticamente
adhdev standalone --dev           # activa la API de DevServer (:19280) para depurar y probar proveedores
adhdev-standalone --public <dir>  # (paquete standalone) sirve una compilación propia del panel web
```

Standalone permanece solo en localhost por defecto. Si te enlazas a `0.0.0.0` para acceso por LAN, el panel avisa cuando no hay configurada ni autenticación por token ni contraseña del panel.

> **Nota sobre Windows:** Windows + Node.js 24 o superior está actualmente bloqueado para las rutas normales de arranque e instalación. Usa Node.js 22.x, o el instalador de PowerShell: `irm https://adhf.dev/install.ps1 | iex` ([documentación](https://docs.adhf.dev)).

Documentación autoalojada de referencia:

- [Configuración inicial del autoalojamiento](docs/self-hosted/setup.md)
- [Configuración del autoalojamiento](docs/self-hosted/configuration.md)
- [API local del autoalojamiento](docs/self-hosted/local-api.md)

### Los primeros cinco minutos

1. **Inicia el daemon** — `adhdev standalone`, y abre `http://localhost:3847`. El panel detecta qué agentes están instalados en esta máquina.
2. **Lanza una sesión.** Elige un proveedor (por ejemplo Claude Code), elige un directorio de trabajo y arráncalo. Ya tienes una sesión de agente real que puedes manejar desde el chat *o* ver como un terminal en bruto — alterna entre los dos.
3. **Envía trabajo y aléjate.** Escribe una tarea. Cuando el agente llegue a un aviso de permiso, aparecerá como una aprobación en la bandeja de actividad del panel en lugar de bloquear un terminal que no estás mirando. (Las notificaciones push al teléfono para esas aprobaciones son una función cloud.)
4. **Pega una captura de pantalla en el chat** cuando una descripción no baste — pasa directamente al contexto del agente.
5. **Prueba el mesh en una sola máquina.** Abre `/mesh`, crea un mesh vinculado a tu repositorio y clona un nodo worktree. Encola una tarea para él y observa el libro mayor: despacho → finalización → Refinery → rebase y fusión en `main`. Todo esto funciona autoalojado; solo cruzar a una *segunda máquina* requiere la edición cloud.

¿Atascado? La [guía de configuración del autoalojamiento](docs/self-hosted/setup.md) cubre los puertos, la exposición en LAN y los problemas de detección de proveedores.

---

## Agentes compatibles

ADHDev se comunica con los agentes de programación mediante tres categorías de proveedor: `ide` (CDP), `extension` (CDP webview) y `cli` (PTY).

**Agentes CLI** (manejados por PTY, lanzados y controlados desde el panel):

| Agente | Proveedor |
| --- | --- |
| Claude Code | `cli/claude-cli` |
| Codex CLI | `cli/codex-cli` |
| Cursor Agent | `cli/cursor-cli` |
| Google Antigravity CLI | `cli/antigravity-cli` |
| Grok CLI | `cli/grok-cli` |
| Kimi Code | `cli/kimi` |
| Opencode | `cli/opencode` |

**IDE** (mediante Chrome DevTools Protocol): Cursor, Google Antigravity, VS Code, VSCodium, Kiro, Windsurf, Trae, PearAI.

**Extensiones de IDE** (CDP webview): Claude Code (VS Code), Codex, Cline, Roo Code.

> **Incluido ≠ verificado.** ADHDev incluye un inventario amplio; estar en el catálogo significa que la integración existe, no que cada una haya sido validada de extremo a extremo. Los niveles de soporte varían. Consulta la política vigente:
>
> - [Proveedores compatibles](https://docs.adhf.dev/reference/supported-providers)
> - [IDE compatibles](https://docs.adhf.dev/reference/supported-ides)
> - [Compatibilidad y advertencias](https://docs.adhf.dev/guide/compatibility)

ADHDev **no** gestiona las claves de API de tus agentes — cada herramienta se encarga de su propia autenticación. ADHDev detecta el estado de instalación y muestra los errores.

### Añade tu propio agente

Los proveedores son datos, no código que tengas que bifurcar. Un proveedor es un manifiesto versionado (`provider.v1.json`) más scripts que describen cómo detectar la herramienta, lanzarla, interpretar su salida como turnos de chat y reconocer sus avisos de aprobación. Coloca uno en `~/.adhdev/providers/` y el panel lo recoge — tu sobrescritura prevalece sobre el integrado del mismo nombre, así que puedes arreglar un parser roto en local sin esperar a una versión.

- Los niveles de verificación son explícitos: **Verified / Partial / Unverified**. “Integrado” solo significa que la integración existe.
- Guías: [Proveedores compatibles](https://docs.adhf.dev/reference/supported-providers) · [Guía de proveedores personalizados](https://docs.adhf.dev/guide/custom-providers)

Si consigues que funcione un agente que no está en el catálogo, esa es la contribución más útil que puedes hacer — ábrela en [vilmire/adhdev-providers](https://github.com/vilmire/adhdev-providers). Los pull requests al núcleo aquí requieren firmar el CLA (el bot te lo solicita).

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=vilmire/adhdev&type=Date)](https://star-history.com/#vilmire/adhdev&Date)

---

## Comunidad

- 💬 [Discord](https://discord.gg/WJD3tCfBzk)
- 🐛 [Issues](https://github.com/vilmire/adhdev/issues)
- 🤝 [Contributing](CONTRIBUTING.md)
- 📋 [Changelog](CHANGELOG.md)

---

## Qué hay en este repositorio

Esta es la edición de código abierto y autoalojada (AGPL-3.0). Las operaciones de la nube alojada no forman parte de este repositorio. La edición autoalojada se construye en torno a tres capas locales:

1. `daemon-standalone` expone un servidor HTTP/WebSocket local y sirve la interfaz web.
2. `daemon-core` gestiona las integraciones de IDE, CLI y extensiones.
3. `session-host-daemon` (`adhdev-sessiond`) es dueño de los runtimes PTY de larga duración para que las sesiones de CLI sobrevivan a los reinicios del daemon.

| Ruta | Propósito |
| --- | --- |
| `packages/daemon-core` | Motor compartido: proveedores, CDP, enrutamiento de comandos, estado de sesiones/runtime |
| `packages/daemon-standalone` | Servidor HTTP/WS local e interfaz standalone incluida |
| `packages/web-core` | Páginas, componentes, hooks y abstracciones de transporte de React compartidos |
| `packages/web-standalone` | Aplicación de panel standalone |
| `packages/session-host-core` | Protocolo, cliente, registro, búfer circular y etiquetas del session-host |
| `packages/session-host-daemon` | Proceso dueño de los runtimes PTY de larga duración |
| `packages/terminal-mux-*` | Pila local de terminal mux |
| `packages/terminal-render-web` | Soporte de renderizado de terminal en el navegador |
| `packages/ghostty-vt-node` | Bindings de Ghostty VT usados por las capas de runtime/mux |

### Superficie de la API standalone

- `GET /api/v1/status` — el array sessions[] es la fuente de verdad
- `POST /api/v1/command`
- `GET /api/v1/runtime/:sessionId/snapshot`
- `GET /api/v1/runtime/:sessionId/events`
- `GET /api/v1/mux/:workspace/state`
- `POST /api/v1/mux/:workspace/control`
- `ws://localhost:3847/ws`

Referencia: [Documentación de la API autoalojada](docs/self-hosted/local-api.md)

---

## Desarrollar desde el código fuente

`vendor/seqscribe` es un submódulo de git del que depende la compilación del daemon, así que clona con `--recurse-submodules` (en un clon existente: `git submodule update --init --recursive`):

```bash
git clone --recurse-submodules https://github.com/vilmire/adhdev.git
cd adhdev
npm install
npm run build
npm run dev
```

Scripts útiles del espacio de trabajo:

```bash
npm run dev:daemon
npm run dev:web
```

---

## OSS frente a Cloud

El motor es de código abierto. Lo que añade la nube es una **capa de alcance**: cuentas, más de una máquina, acceso remoto por todo internet y notificaciones push.

| | OSS (autoalojado) | Cloud ([adhf.dev](https://adhf.dev)) |
| --- | :--: | :--: |
| Panel | `localhost:3847` | `adhf.dev`, cualquier navegador o teléfono |
| Cuenta necesaria | ❌ sin autenticación | OAuth (GitHub / Google) |
| Máquinas | **1** | 1 / 2 / 5 según el plan |
| Alcance | localhost, o tu LAN con `--host` | **en cualquier lugar** (P2P WebRTC + TURN para redes restringidas) |
| Todos los proveedores (CLI / IDE / extensión) | ✅ | ✅ |
| Repo Mesh, Refinery, nodos worktree | ✅ **el mesh de una sola máquina se ejecuta totalmente en local** | ✅ |
| Mesh **entre máquinas** | ❌ (sin relé entre máquinas) | ✅ |
| Asistente (transmisiones, resumen diario, respuestas con un toque) | ✅ | ✅ |
| Asistente que sigue proyectos en tus otras máquinas | ❌ | ✅ |
| Transferencia de archivos de proyecto entre tus máquinas | ❌ | ✅ |
| Notificaciones push (aprobación / finalización / error) | ❌ | ✅ |
| API REST alojada + claves de API | ❌ (solo API local) | ✅ |
| Precio | gratis, sin cuotas | Free / Pro / Ultra |

Si solo manejas una máquina y te quedas en tu propia red, el autoalojamiento te da todo salvo las notificaciones push y las funciones que abarcan varias máquinas (el mesh entre máquinas, seguir o mover proyectos entre máquinas) — sin cuotas. La nube existe para el momento en que añades una segunda máquina o quieres llegar a tus agentes desde fuera de casa.

---

## Licencia

AGPL-3.0-or-later. Consulta [LICENSE](LICENSE).
