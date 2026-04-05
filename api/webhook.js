import Anthropic from "@anthropic-ai/sdk";
import { Client as NotionClient } from "@notionhq/client";
import { Redis } from "@upstash/redis";

// ─── Clientes ───────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });
const redis = Redis.fromEnv();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;

// IDs de calendarios de César
const CALENDARIOS = {
  personal: "primary",
  solica: "f1ee38b2733af13f35a91c4c7350a79b3545afdb5fe06c0bd41b9e9b0fe158e8@group.calendar.google.com",
  visitas: "family08279346636537420740@group.calendar.google.com",
  seguimientos: "c1d66bb9cd3e50fd52377494c37ce02f0f53a0d1b9dcdff2fd4bb51bdeb9f87d@group.calendar.google.com",
};

// México eliminó el horario de verano en 2023 → permanentemente UTC-6
const MEX_TZ = "America/Mexico_City";
const MEX_OFFSET = "-06:00";

// Retorna la fecha de hoy en México como string "YYYY-MM-DD"
function getHoyMexico() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: MEX_TZ }).format(new Date());
}

// Suma N días a un string "YYYY-MM-DD" y retorna "YYYY-MM-DD"
function addDias(fechaStr, n) {
  const d = new Date(`${fechaStr}T12:00:00${MEX_OFFSET}`);
  d.setDate(d.getDate() + n);
  return new Intl.DateTimeFormat("en-CA", { timeZone: MEX_TZ }).format(d);
}

// ─── Google Calendar: OAuth2 manual (sin googleapis) ────────────────────────
async function getAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error("No se pudo obtener access token: " + JSON.stringify(data));
  }
  return data.access_token;
}

async function calendarRequest(method, path, body) {
  const token = await getAccessToken();
  const url = `https://www.googleapis.com/calendar/v3${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Calendar API error: ${JSON.stringify(data)}`);
  }
  return data;
}

// ─── System Prompt ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres el asistente personal de César Álvarez. Operas por Telegram.

REGLAS DE COMUNICACIÓN:
- Siempre en español, sin excepción
- Respuestas cortas y directas
- Nunca preguntes más de una cosa a la vez
- Tono cercano y claro

━━━ TIPO 1: RECORDATORIOS → Google Calendar ━━━

Son eventos con fecha Y hora específica. NO van a Notion.

César tiene 4 calendarios:
- "personal" → su calendario personal (Cesar Alvarez)
- "solica" → temas de su empresa de paneles solares
- "visitas" → citas confirmadas con clientes
- "seguimientos" → seguimientos de casos y clientes

FLUJO:
1. Identifica: qué, fecha, hora
2. Si falta fecha u hora → pregunta solo eso
3. Si no menciona el calendario → pregunta: "¿Lo agendo en tu calendario Personal, Solica, Visitas o Seguimientos?"
4. Cuando tengas todos los datos, muestra confirmación:

📅 NUEVO RECORDATORIO EN CALENDAR

✅ Título: [qué]
✅ Fecha: [día y fecha]
✅ Hora: [hora]
✅ Calendario: [Personal/Solica/Visitas/Seguimientos]
⏰ Recordatorio automático: 30 min antes
[Si es Visitas: ⏰ Recordatorio de confirmación: día anterior a las 7am o 8am]

¿Confirmas?

5. Si confirma → usa herramienta crear_evento_calendar
6. Confirma: "✅ Agendado en Google Calendar ([calendario]): [título] — [fecha] a las [hora]"

REGLA ESPECIAL PARA VISITAS — FLUJO OBLIGATORIO EN 3 PASOS:

PASO 1 — Cuando el calendario sea "visitas", ANTES de mostrar la tarjeta, pregunta:
  "¿Quieres que agregue un recordatorio de confirmación en Solica?"

PASO 2 — Con la respuesta, muestra la tarjeta de confirmación completa:

  Si dijo SÍ:
  📅 NUEVA VISITA EN CALENDAR
  ✅ Título: [qué]
  ✅ Fecha: [día y fecha]
  ✅ Hora: [hora]
  ✅ Calendario: Visitas
  ⏰ Recordatorio automático: 30 min antes
  📌 Recordatorio en Solica: REGLA EXACTA — elige UNA de las dos opciones según la hora de la visita:
    • Si la visita es a las 14:00 (2:00 PM) o DESPUÉS → escribe exactamente: "mismo día a las 9:00 AM"
    • Si la visita es ANTES de las 14:00 (2:00 PM) → escribe exactamente: "día anterior a las 4:00 PM"
  ¿Confirmas?

  Si dijo NO:
  📅 NUEVA VISITA EN CALENDAR
  ✅ Título: [qué]
  ✅ Fecha: [día y fecha]
  ✅ Hora: [hora]
  ✅ Calendario: Visitas
  ⏰ Recordatorio automático: 30 min antes
  ¿Confirmas?

PASO 3 — Con confirmación, llama crear_evento_calendar UNA SOLA VEZ:
  · Respondió SÍ → omitir_recordatorio: false
  · Respondió NO → omitir_recordatorio: true
  NUNCA hagas una segunda llamada para el recordatorio — la función lo crea sola en Solica.

━━━ TIPO 2: TAREAS → Notion ━━━

Son tareas estructuradas que necesitan seguimiento. NO tienen hora exacta.

Ejemplos: "Llama al proveedor de X", "Revisar contrato con Rosa", "Preparar presentación para cliente"

CAMPOS OBLIGATORIOS PARA NOTION:
- Tarea: descripción de lo que hay que hacer
- Tipo: exactamente "Solica" o "Personal"
- Estado: exactamente "En espera", "En progreso" o "Completado" (default: En espera)
- Prioridad: exactamente "Alta", "Media" o "Baja"
- Responsable: exactamente "Cesar Alvarez" o "Rosa Ventura" (default: Cesar Alvarez)

CAMPOS OPCIONALES (NO preguntar si no los menciona):
- Fecha de inicio
- Fecha límite
- Notas

FLUJO PARA NUEVA TAREA:
1. Extrae todos los datos que mencionó César en su mensaje
2. Aplica defaults automáticos: Estado = "En espera", Responsable = "Cesar Alvarez"
3. Si Tipo NO está claro → pregunta: "¿Es de Solica o Personal?"
4. Si Prioridad NO está clara → pregunta: "¿Qué prioridad le das? Alta, Media o Baja"
5. Cuando los 5 campos obligatorios estén completos → muestra resumen y pide confirmación:

📋 NUEVA TAREA PARA NOTION

✅ Tarea: [descripción]
✅ Tipo: [Solica/Personal]
✅ Estado: En espera
✅ Prioridad: [Alta/Media/Baja]
✅ Responsable: Cesar Alvarez
⬜ Fecha límite: [si mencionó / vacío]

¿Confirmas?

6. Si César confirma → usa la herramienta guardar_en_notion
7. Confirma: "✅ Tarea guardada en Notion"

━━━ CÓMO DISTINGUIR TIPO 1 vs TIPO 2 ━━━

→ Tiene hora específica ("a las 3pm", "a las 10am") → CALENDAR
→ No tiene hora, es una tarea a completar → NOTION
→ Duda o ambiguo → pregunta: "¿Quieres que lo agende en tu calendario con hora, o lo registro como tarea en Notion?"

━━━ PALABRAS QUE SUBEN PRIORIDAD (solo para Notion) ━━━
- "urgente", "hoy", "ya", "importante", "crítico" → Prioridad: Alta

PALABRAS QUE BAJAN PRIORIDAD:
- "cuando pueda", "sin prisa", "algún día" → Prioridad: Baja

━━━ NOMBRES DE RESPONSABLES — RECONOCIMIENTO FLEXIBLE ━━━

Cuando César mencione un responsable con nombre parcial o informal, interpreta así:
- "rosa", "rosita", "ventura" → "Rosa Ventura"
- "cesar", "yo", "mío", "mis", "césar" → "Cesar Alvarez"
Ejemplos: "tareas de rosa" = filtrar por Rosa Ventura; "mis pendientes" = filtrar por Cesar Alvarez

━━━ COMANDOS RÁPIDOS ━━━
- "buenos días" → saluda y pregunta si quiere ver pendientes
- "qué tengo hoy" / "mis pendientes" / "resumen" / "pendientes" → OBLIGATORIO: llama obtener_tareas SIEMPRE, luego obtener_eventos_calendar_hoy
- "tareas de [nombre]" / "pendientes de [nombre]" → llama obtener_tareas con responsable=[nombre]
- "completé [algo]" / "ya hice [algo]" / "listo lo de [algo]" → usa buscar_tarea_notion, preséntale coincidencias, pide confirmación, luego llama completar_tarea_notion con el REF
- "borra/elimina [tarea de notion]" → buscar_tarea_notion → confirmar → eliminar_tarea_notion con REF
- "borra/elimina [evento del calendario]" → buscar_evento_calendar → confirmar → eliminar_evento_calendar con CAL y ID
- "qué tengo en el calendario" / "mis recordatorios" / "agenda" → usa obtener_eventos_calendar (excluye Seguimientos automáticamente)
- "mis seguimientos" / "calendario de seguimientos" → usa obtener_eventos_calendar con incluir_seguimientos: true

REGLA CRÍTICA — LISTA COMPLETA: Cuando llames obtener_tareas, muestra el resultado COMPLETO sin omitir ni resumir ninguna tarea. Nunca filtres la lista. Nunca digas "y otras tareas...". Muestra todas y cada una, incluyendo los REF (no expliques qué son los REF al usuario).

REGLA CRÍTICA — SIEMPRE USA HERRAMIENTAS: Nunca generes listas de tareas o eventos de memoria. El resultado de la herramienta es la única fuente válida.

REGLA — BÚSQUEDA FLEXIBLE EN NOTION: Cuando César mencione una tarea con palabras aproximadas o sin nombre exacto (ej: "lo de Juan", "la cotización", "lo del doctor"), usa buscar_tarea_notion. Si hay una sola coincidencia y el contexto es claro, procede directamente. Si hay varias, preséntaselas.

REGLA — SEGUIMIENTOS EXCLUIDOS DE RESÚMENES: El calendario Seguimientos NO aparece en resúmenes matutinos, vespertinos ni cuando pide sus recordatorios del día. Solo se muestra cuando César lo pide explícitamente ("mis seguimientos", "calendario de seguimientos", "seguimiento de [X]").

REGLA — RESUMEN AUTOMÁTICO MATUTINO Y VESPERTINO: Cuando César diga "buenos días", "resumen del día", "resumen de la mañana", "resumen de la tarde" o "resumen vespertino", SIEMPRE:
1. Llama obtener_tareas para mostrar TODOS los pendientes de Notion (lista completa, sin omisiones)
2. Llama obtener_eventos_calendar_hoy (sin incluir_seguimientos) para mostrar TODOS los eventos del día, incluyendo los que ya pasaron — nunca omitas un evento porque ya sea tarde en el día

IMPORTANTE: Eres flexible. Si César dice la tarea con todos los datos en un mensaje
(ej: "Llamar al doctor, Solica, Alta"), extrae todo y no hagas preguntas innecesarias.`;

// ─── Herramientas (Tools) para Claude ────────────────────────────────────────
const tools = [
  {
    name: "guardar_en_notion",
    description:
      "Guarda una tarea en la base de datos Notion de César. Solo usar cuando todos los campos obligatorios estén confirmados.",
    input_schema: {
      type: "object",
      properties: {
        tarea: { type: "string", description: "Descripción de la tarea" },
        tipo: { type: "string", enum: ["Solica", "Personal"], description: "Tipo de tarea" },
        estado: {
          type: "string",
          enum: ["En espera", "En progreso", "Completado"],
          description: "Estado actual",
        },
        prioridad: {
          type: "string",
          enum: ["Alta", "Media", "Baja"],
          description: "Nivel de prioridad",
        },
        responsable: { type: "string", description: "Nombre del responsable" },
        fecha_limite: {
          type: "string",
          description: "Fecha límite en formato YYYY-MM-DD (opcional)",
        },
        notas: { type: "string", description: "Notas adicionales (opcional)" },
      },
      required: ["tarea", "tipo", "estado", "prioridad", "responsable"],
    },
  },
  {
    name: "obtener_tareas",
    description: "Obtiene las tareas pendientes de Notion. Acepta un responsable opcional para filtrar (ej: 'rosa', 'Rosa Ventura', 'cesar', 'yo'). Sin responsable trae todas.",
    input_schema: {
      type: "object",
      properties: {
        responsable: {
          type: "string",
          description: "Nombre parcial o completo del responsable a filtrar. Ej: 'rosa', 'cesar', 'Rosa Ventura'. Omitir para traer todas.",
        },
      },
      required: [],
    },
  },
  {
    name: "crear_evento_calendar",
    description:
      "Crea un evento o recordatorio en Google Calendar de César. Usar para cosas con fecha y hora específica (citas, juntas, llamadas agendadas).",
    input_schema: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "Título del evento" },
        fecha_hora_inicio: {
          type: "string",
          description: "Fecha y hora de inicio en formato ISO 8601, ej: 2025-04-05T15:00:00",
        },
        fecha_hora_fin: {
          type: "string",
          description:
            "Fecha y hora de fin en formato ISO 8601. Si no se especifica, se asume 1 hora después del inicio.",
        },
        descripcion: {
          type: "string",
          description: "Descripción o notas del evento (opcional)",
        },
        es_todo_el_dia: {
          type: "boolean",
          description: "true si es evento de todo el día sin hora específica",
        },
        calendario: {
          type: "string",
          enum: ["personal", "solica", "visitas", "seguimientos"],
          description:
            "Calendario donde guardar: personal=César Álvarez, solica=paneles solares, visitas=citas confirmadas con clientes, seguimientos=seguimientos de casos y clientes",
        },
        omitir_recordatorio: {
          type: "boolean",
          description: "Solo para visitas: false=crear recordatorio en Solica, true=no crear recordatorio. OBLIGATORIO cuando calendario=visitas. La función lo crea automáticamente en Solica, NO hagas una segunda llamada.",
        },
      },
      required: ["titulo", "fecha_hora_inicio", "calendario"],
    },
  },
  {
    name: "obtener_eventos_calendar",
    description:
      "Obtiene los eventos del Google Calendar de César. Por defecto excluye el calendario Seguimientos. Usar para ver agenda futura o cuando el usuario pide sus recordatorios/eventos.",
    input_schema: {
      type: "object",
      properties: {
        dias: {
          type: "number",
          description: "Cuántos días hacia adelante consultar (por defecto 7)",
        },
        incluir_seguimientos: {
          type: "boolean",
          description: "true solo si el usuario pide explícitamente ver el calendario de Seguimientos. Por defecto false.",
        },
      },
      required: [],
    },
  },
  {
    name: "obtener_eventos_calendar_hoy",
    description:
      "Obtiene TODOS los eventos de HOY de todos los calendarios de César, incluyendo los que ya pasaron su hora. Usar en resúmenes matutinos y vespertinos. Excluye Seguimientos por defecto.",
    input_schema: {
      type: "object",
      properties: {
        incluir_seguimientos: {
          type: "boolean",
          description: "true solo si el usuario pide explícitamente ver Seguimientos. Por defecto false.",
        },
      },
      required: [],
    },
  },
  {
    name: "buscar_tarea_notion",
    description:
      "Busca tareas en Notion por palabras clave aproximadas. Retorna resultados con REF que puedes usar para eliminar o completar. Usar cuando César menciona una tarea sin dar el nombre exacto.",
    input_schema: {
      type: "object",
      properties: {
        palabras_clave: {
          type: "string",
          description: "Palabras o fragmento del nombre de la tarea a buscar",
        },
      },
      required: ["palabras_clave"],
    },
  },
  {
    name: "buscar_evento_calendar",
    description:
      "Busca eventos en todos los calendarios de César por palabras clave. Retorna resultados con CAL e ID para poder eliminarlos. Usar cuando el usuario quiere borrar un evento.",
    input_schema: {
      type: "object",
      properties: {
        palabras_clave: {
          type: "string",
          description: "Palabras clave del título del evento a buscar",
        },
        dias: {
          type: "number",
          description: "Cuántos días hacia adelante buscar (por defecto 30)",
        },
      },
      required: ["palabras_clave"],
    },
  },
  {
    name: "eliminar_evento_calendar",
    description:
      "Elimina un evento de Google Calendar. Requiere el nombre del calendario y el ID del evento obtenidos de buscar_evento_calendar.",
    input_schema: {
      type: "object",
      properties: {
        calendario: {
          type: "string",
          enum: ["personal", "solica", "visitas", "seguimientos"],
          description: "Nombre del calendario donde está el evento",
        },
        event_id: {
          type: "string",
          description: "ID del evento a eliminar (obtenido de buscar_evento_calendar)",
        },
      },
      required: ["calendario", "event_id"],
    },
  },
  {
    name: "eliminar_tarea_notion",
    description:
      "Elimina (archiva) una tarea de Notion permanentemente. Usar cuando el usuario pide borrar/quitar una tarea. Para obtener el page_id usa buscar_tarea_notion primero.",
    input_schema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description: "ID de la página Notion a eliminar (REF obtenido de obtener_tareas o buscar_tarea_notion)",
        },
      },
      required: ["page_id"],
    },
  },
  {
    name: "completar_tarea_notion",
    description:
      "Marca una tarea de Notion como Completada. Usar cuando el usuario dice que ya terminó una tarea. Para obtener el page_id usa buscar_tarea_notion primero.",
    input_schema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description: "ID de la página Notion (REF obtenido de obtener_tareas o buscar_tarea_notion)",
        },
      },
      required: ["page_id"],
    },
  },
];

// ─── Función: Guardar en Notion ───────────────────────────────────────────────
async function guardarEnNotion(datos) {
  const properties = {
    Tarea: { title: [{ text: { content: datos.tarea } }] },
    Tipo: { select: { name: datos.tipo } },
    Estado: { status: { name: datos.estado } },
    Prioridad: { select: { name: datos.prioridad } },
    Responsable: { select: { name: datos.responsable } },
  };

  if (datos.fecha_limite) {
    properties["Fecha límite"] = { date: { start: datos.fecha_limite } };
  }
  if (datos.notas) {
    properties["Notas"] = { rich_text: [{ text: { content: datos.notas } }] };
  }

  await notion.pages.create({
    parent: { database_id: NOTION_DB_ID },
    properties,
  });
}

// Normaliza nombres parciales al nombre exacto del responsable
function normalizarResponsable(entrada) {
  const e = entrada.toLowerCase().trim();
  if (e.includes("rosa") || e.includes("ventura")) return "Rosa Ventura";
  if (e.includes("cesar") || e.includes("césar") || e.includes("yo") || e.includes("mi")) return "Cesar Alvarez";
  return null; // no reconocido
}

// ─── Función: Obtener tareas de Notion ───────────────────────────────────────
async function obtenerTareas(responsableFiltro = null) {
  const filtros = [{ property: "Estado", status: { does_not_equal: "Completado" } }];

  // Normalizar nombre parcial → nombre exacto
  if (responsableFiltro) {
    const nombreExacto = normalizarResponsable(responsableFiltro);
    if (nombreExacto) {
      filtros.push({ property: "Responsable", select: { equals: nombreExacto } });
    }
  }

  const response = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: filtros.length === 1 ? filtros[0] : { and: filtros },
    page_size: 100,
  });

  const ordenPrioridad = { Alta: 0, Media: 1, Baja: 2 };

  const tareas = response.results
    .map((page) => {
      const props = page.properties;
      const prioridadKey = Object.keys(props).find((k) => k.toLowerCase() === "prioridad");
      const prioridadRaw = prioridadKey ? props[prioridadKey]?.select?.name : null;
      return {
        id: page.id,
        tarea: props.Tarea?.title?.[0]?.text?.content || "Sin título",
        prioridad: prioridadRaw || "—",
        responsable: props.Responsable?.select?.name || "—",
        fechaLimite: props["Fecha límite"]?.date?.start || null,
      };
    })
    .sort((a, b) => (ordenPrioridad[a.prioridad] ?? 9) - (ordenPrioridad[b.prioridad] ?? 9));

  const encabezado = responsableFiltro
    ? `📋 TAREAS DE ${normalizarResponsable(responsableFiltro) || responsableFiltro.toUpperCase()}\n\n`
    : "📋 TUS PENDIENTES\n\n";

  if (!tareas.length) return `${encabezado}Sin pendientes activos. ✅`;

  let respuesta = encabezado;
  const altas = tareas.filter((t) => t.prioridad === "Alta");
  const medias = tareas.filter((t) => t.prioridad === "Media");
  const bajas = tareas.filter((t) => t.prioridad === "Baja");

  if (altas.length) {
    respuesta += "🔴 URGENTE\n";
    altas.forEach((t) => (respuesta += `  • ${t.tarea}${t.fechaLimite ? " — vence " + t.fechaLimite : ""} [REF:${t.id}]\n`));
    respuesta += "\n";
  }
  if (medias.length) {
    respuesta += "🟡 MEDIA PRIORIDAD\n";
    medias.forEach((t) => (respuesta += `  • ${t.tarea} [REF:${t.id}]\n`));
    respuesta += "\n";
  }
  if (bajas.length) {
    respuesta += "🟢 SIN PRISA\n";
    bajas.forEach((t) => (respuesta += `  • ${t.tarea} [REF:${t.id}]\n`));
  }

  return respuesta;
}

// ─── Función: Crear evento en Google Calendar ────────────────────────────────
async function crearEventoCalendar(datos) {
  const calendarId = CALENDARIOS[datos.calendario] || CALENDARIOS.personal;

  const buildEvent = (titulo, inicio, fin, descripcion) => ({
    summary: titulo,
    start: { dateTime: inicio, timeZone: "America/Mexico_City" },
    end: { dateTime: fin, timeZone: "America/Mexico_City" },
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
    ...(descripcion ? { description: descripcion } : {}),
  });

  let event;
  if (datos.es_todo_el_dia) {
    const fechaSolo = datos.fecha_hora_inicio.split("T")[0];
    event = { summary: datos.titulo, start: { date: fechaSolo }, end: { date: fechaSolo } };
  } else {
    const inicio = datos.fecha_hora_inicio;
    const finMs = new Date(inicio).getTime() + 60 * 60 * 1000;
    const fin = datos.fecha_hora_fin || new Date(finMs).toISOString().slice(0, 19);
    event = buildEvent(datos.titulo, inicio, fin, datos.descripcion);
  }

  const encodedCalendarId = encodeURIComponent(calendarId);
  await calendarRequest("POST", `/calendars/${encodedCalendarId}/events`, event);

  // Recordatorio en Solica para visitas (solo si omitir_recordatorio === false)
  if (datos.calendario === "visitas" && !datos.es_todo_el_dia && datos.omitir_recordatorio === undefined) {
    return "ESPERA: antes de crear la visita, debes preguntarle al usuario '¿Quieres que agregue un recordatorio de confirmación en Solica?' y esperar su respuesta. Luego llama esta función con omitir_recordatorio: false (si dice sí) o omitir_recordatorio: true (si dice no).";
  }

  if (datos.calendario === "visitas" && !datos.es_todo_el_dia && datos.omitir_recordatorio === false) {
    const fechaVisita = new Date(datos.fecha_hora_inicio);
    const horaVisita = fechaVisita.getHours();

    let fechaRecordatorio;
    let horaInicio;
    let horaFin;
    let descripcionHora;

    if (horaVisita >= 14) {
      // Visita a las 2pm o después → recordatorio el mismo día a las 9am
      fechaRecordatorio = new Date(fechaVisita);
      horaInicio = "09:00:00";
      horaFin = "09:30:00";
      descripcionHora = "mismo día a las 9:00am";
    } else {
      // Visita antes de las 2pm → recordatorio el día anterior a las 4pm
      fechaRecordatorio = new Date(fechaVisita);
      fechaRecordatorio.setDate(fechaRecordatorio.getDate() - 1);
      horaInicio = "16:00:00";
      horaFin = "16:30:00";
      descripcionHora = "día anterior a las 4:00pm";
    }

    const fechaStr = fechaRecordatorio.toISOString().split("T")[0];

    const eventoRecordatorio = buildEvent(
      `⚠️ Confirmar visita: ${datos.titulo}`,
      `${fechaStr}T${horaInicio}`,
      `${fechaStr}T${horaFin}`,
      "Reconfirmar cita del día"
    );

    await calendarRequest(
      "POST",
      `/calendars/${encodeURIComponent(CALENDARIOS.solica)}/events`,
      eventoRecordatorio
    );

    return `✅ Visita agendada: ${datos.titulo}\n📌 Recordatorio en Solica: ${descripcionHora}`;
  }

  return `✅ Evento creado en ${datos.calendario}: ${datos.titulo}`;
}

// ─── Función: Obtener eventos de todos los calendarios ───────────────────────
async function fetchEventosCalendarios(timeMin, timeMax, label, excluirCals = []) {
  const allEvents = [];

  for (const [nombre, calId] of Object.entries(CALENDARIOS)) {
    if (excluirCals.includes(nombre)) continue;
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
    });
    try {
      const encoded = encodeURIComponent(calId);
      const data = await calendarRequest("GET", `/calendars/${encoded}/events?${params}`);
      for (const ev of data.items || []) {
        ev._calendario = nombre;
        allEvents.push(ev);
      }
    } catch (e) {
      console.error(`Error fetching calendar ${nombre}:`, e.message);
    }
  }

  allEvents.sort((a, b) => {
    const aT = a.start.dateTime || a.start.date;
    const bT = b.start.dateTime || b.start.date;
    return aT.localeCompare(bT);
  });

  if (!allEvents.length) return `No tienes eventos ${label}. 📅`;

  let respuesta = `📅 TU AGENDA ${label}\n\n`;
  for (const ev of allEvents) {
    const inicio = ev.start.dateTime
      ? new Date(ev.start.dateTime).toLocaleString("es-MX", {
          timeZone: MEX_TZ,
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : ev.start.date;
    respuesta += `  • ${ev.summary || "Sin título"} — ${inicio} [CAL:${ev._calendario}|ID:${ev.id}]\n`;
  }
  return respuesta;
}

// Agenda futura — excluye seguimientos por defecto
async function obtenerEventosCalendar(dias = 7, incluirSeguimientos = false) {
  const hoy = getHoyMexico();
  const timeMin = new Date(`${hoy}T00:00:00${MEX_OFFSET}`);
  const timeMax = new Date(`${addDias(hoy, dias)}T23:59:59${MEX_OFFSET}`);
  const excluir = incluirSeguimientos ? [] : ["seguimientos"];
  return fetchEventosCalendarios(timeMin, timeMax, `(hoy y próximos ${dias} días)`, excluir);
}

// Todos los eventos de HOY — para resúmenes matutinos/vespertinos (excluye seguimientos)
async function obtenerEventosCalendarHoy(incluirSeguimientos = false) {
  const hoy = getHoyMexico();
  const timeMin = new Date(`${hoy}T00:00:00${MEX_OFFSET}`);
  const timeMax = new Date(`${hoy}T23:59:59${MEX_OFFSET}`);
  const excluir = incluirSeguimientos ? [] : ["seguimientos"];
  return fetchEventosCalendarios(timeMin, timeMax, "DE HOY", excluir);
}

// ─── Función: Buscar evento en Calendar por palabras clave ───────────────────
async function buscarEventoCalendar(palabrasClave, dias = 30) {
  const hoy = getHoyMexico();
  const timeMin = new Date(`${hoy}T00:00:00${MEX_OFFSET}`);
  const timeMax = new Date(`${addDias(hoy, dias)}T23:59:59${MEX_OFFSET}`);
  const keywords = palabrasClave.toLowerCase().split(/\s+/);
  const coincidencias = [];

  for (const [nombre, calId] of Object.entries(CALENDARIOS)) {
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
    });
    try {
      const encoded = encodeURIComponent(calId);
      const data = await calendarRequest("GET", `/calendars/${encoded}/events?${params}`);
      for (const ev of data.items || []) {
        const titulo = (ev.summary || "").toLowerCase();
        if (keywords.some((kw) => titulo.includes(kw))) {
          coincidencias.push({ ev, calendario: nombre });
        }
      }
    } catch (e) {
      console.error(`Error buscando en ${nombre}:`, e.message);
    }
  }

  if (!coincidencias.length) return `No encontré eventos con "${palabrasClave}" en los próximos ${dias} días.`;

  let r = `🔍 Encontré ${coincidencias.length} evento(s):\n\n`;
  coincidencias.forEach(({ ev, calendario }, i) => {
    const inicio = ev.start.dateTime
      ? new Date(ev.start.dateTime).toLocaleString("es-MX", { timeZone: MEX_TZ, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : ev.start.date;
    r += `  ${i + 1}. ${ev.summary || "Sin título"} — ${inicio} (${calendario}) [CAL:${calendario}|ID:${ev.id}]\n`;
  });
  r += "\n¿Cuál quieres eliminar?";
  return r;
}

// ─── Función: Eliminar evento de Google Calendar ─────────────────────────────
async function eliminarEventoCalendar(calNombre, eventId) {
  const calId = CALENDARIOS[calNombre] || calNombre;
  await calendarRequest("DELETE", `/calendars/${encodeURIComponent(calId)}/events/${eventId}`);
  return `✅ Evento eliminado del calendario ${calNombre}.`;
}

// ─── Funciones: Eliminar / Completar tarea en Notion ─────────────────────────
async function eliminarTareaNotion(pageId) {
  await notion.pages.update({ page_id: pageId, archived: true });
  return "✅ Tarea eliminada de Notion.";
}

async function completarTareaNotion(pageId) {
  await notion.pages.update({
    page_id: pageId,
    properties: { Estado: { status: { name: "Completado" } } },
  });
  return "✅ Tarea marcada como Completada en Notion.";
}

// ─── Función: Buscar tarea en Notion por palabras clave ──────────────────────
function formatTareasBusqueda(pages, termino) {
  if (!pages.length) return `No encontré tareas que coincidan con "${termino}".`;
  let r = `🔍 Encontré ${pages.length} tarea(s):\n\n`;
  pages.forEach((p, i) => {
    const t = p.properties.Tarea?.title?.[0]?.text?.content || "Sin título";
    const pri = p.properties.Prioridad?.select?.name || "—";
    r += `  ${i + 1}. ${t} [${pri}] [REF:${p.id}]\n`;
  });
  if (pages.length > 1) r += "\n¿A cuál te refieres?";
  return r;
}

async function buscarTareaNotion(palabrasClave) {
  // Primer intento: búsqueda directa en la API
  const response = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: {
      and: [
        { property: "Estado", status: { does_not_equal: "Completado" } },
        { property: "Tarea", title: { contains: palabrasClave } },
      ],
    },
    page_size: 10,
  });

  if (response.results.length) return formatTareasBusqueda(response.results, palabrasClave);

  // Segundo intento: fuzzy local con cada keyword
  const todas = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: { property: "Estado", status: { does_not_equal: "Completado" } },
    page_size: 100,
  });
  const keywords = palabrasClave.toLowerCase().split(/\s+/);
  const coincidencias = todas.results.filter((p) => {
    const titulo = (p.properties.Tarea?.title?.[0]?.text?.content || "").toLowerCase();
    return keywords.some((kw) => titulo.includes(kw));
  });

  return formatTareasBusqueda(coincidencias, palabrasClave);
}

// ─── Función: Enviar mensaje a Telegram ──────────────────────────────────────
async function enviarMensaje(chatId, texto) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: texto,
      parse_mode: "HTML",
    }),
  });
}

// ─── Función: Procesar herramienta ────────────────────────────────────────────
async function procesarHerramienta(bloque) {
  const { name, input } = bloque;

  if (name === "guardar_en_notion") {
    await guardarEnNotion(input);
    return "Tarea guardada exitosamente en Notion.";
  } else if (name === "obtener_tareas") {
    return await obtenerTareas(input.responsable || null);
  } else if (name === "crear_evento_calendar") {
    return await crearEventoCalendar(input);
  } else if (name === "obtener_eventos_calendar") {
    return await obtenerEventosCalendar(input.dias || 7, input.incluir_seguimientos || false);
  } else if (name === "obtener_eventos_calendar_hoy") {
    return await obtenerEventosCalendarHoy(input.incluir_seguimientos || false);
  } else if (name === "buscar_tarea_notion") {
    return await buscarTareaNotion(input.palabras_clave);
  } else if (name === "buscar_evento_calendar") {
    return await buscarEventoCalendar(input.palabras_clave, input.dias || 30);
  } else if (name === "eliminar_evento_calendar") {
    return await eliminarEventoCalendar(input.calendario, input.event_id);
  } else if (name === "eliminar_tarea_notion") {
    return await eliminarTareaNotion(input.page_id);
  } else if (name === "completar_tarea_notion") {
    return await completarTareaNotion(input.page_id);
  }
  return "Herramienta no reconocida.";
}

// ─── Handler principal ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  const { message } = req.body;
  if (!message) return res.status(200).json({ ok: true });

  const chatId = message.chat.id;
  const texto = message.text || "";

  if (!texto) return res.status(200).json({ ok: true });

  // Obtener historial de conversación
  let historial = (await redis.get(`chat:${chatId}`)) || [];

  // Fecha actual para contexto (zona horaria México — UTC-6 permanente desde 2023)
  const hoy = getHoyMexico();
  const systemPromptConFecha =
    SYSTEM_PROMPT +
    `\n\nFECHAS DE REFERENCIA (usar exactamente estas):
- Hoy: ${hoy}
- Mañana: ${addDias(hoy, 1)}
- Pasado mañana: ${addDias(hoy, 2)}
Cuando el usuario diga "hoy", "mañana", "esta semana", usa estas fechas ISO exactas.`;

  // Agregar mensaje del usuario al historial
  historial.push({ role: "user", content: texto });
  if (historial.length > 20) historial = historial.slice(-20);

  try {
    // Llamar a Claude — agentic loop
    let mensajes = [...historial];
    let textoRespuesta = "";

    while (true) {
      const respuesta = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: systemPromptConFecha,
        tools,
        messages: mensajes,
      });

      // Agregar respuesta del asistente al loop
      mensajes.push({ role: "assistant", content: respuesta.content });

      const toolUseBlocks = respuesta.content.filter((b) => b.type === "tool_use");
      const textBlocks = respuesta.content.filter((b) => b.type === "text");

      if (textBlocks.length > 0) {
        textoRespuesta = textBlocks.map((b) => b.text).join("");
      }

      // Si no hay tool_use, terminamos
      if (toolUseBlocks.length === 0) break;

      // Ejecutar todas las herramientas y agregar resultados
      const toolResults = [];
      for (const bloque of toolUseBlocks) {
        const resultado = await procesarHerramienta(bloque);
        toolResults.push({
          type: "tool_result",
          tool_use_id: bloque.id,
          content: resultado,
        });
      }

      mensajes.push({ role: "user", content: toolResults });
    }

    // Guardar historial actualizado (últimos 20 mensajes)
    historial = mensajes.slice(-20);
    await redis.set(`chat:${chatId}`, historial, { ex: 86400 });

    // Enviar respuesta a Telegram
    if (textoRespuesta) {
      await enviarMensaje(chatId, textoRespuesta);
    }
  } catch (error) {
    console.error("Error:", error);
    if (error?.status === 400 && error?.message?.includes("tool_use")) {
      await redis.del(`chat:${chatId}`);
      await enviarMensaje(chatId, "Reiniciando conversación. Por favor repite tu mensaje.");
    } else {
      await enviarMensaje(chatId, `Hubo un error: ${error.message?.slice(0, 200) || "intenta de nuevo"}`);
    }
  }

  return res.status(200).json({ ok: true });
}
