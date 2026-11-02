// Verificador de la prueba "Biblioteca Comunitaria".
// Levanta el backend y el frontend del alumno, reinicia la base de datos con los datos
// de prueba y comprueba por comportamiento (HTTP + navegador) cada uno de los 10 errores,
// además de un conjunto de regresiones para detectar "arreglos" que rompen otra cosa.
//
// Uso: pnpm grade [ruta-del-proyecto]
// Sin ruta, usa la carpeta actual si contiene backend/ y frontend/; si no, la carpeta padre.
//
// Usa el Chrome o Edge ya instalado. Solo si no hay ninguno descarga Chromium, y lo guarda
// dentro de esta carpeta: al borrarla no queda nada instalado en el equipo.

import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync, copyFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '.browsers')
const { chromium } = await import('playwright-core')
const esProyecto = (dir) => existsSync(path.join(dir, 'backend')) && existsSync(path.join(dir, 'frontend'))
const ROOT = path.resolve(
  process.argv[2] ?? (esProyecto(process.cwd()) ? process.cwd() : path.join(__dirname, '..'))
)
const BACKEND = path.join(ROOT, 'backend')
const FRONTEND = path.join(ROOT, 'frontend')
const WEB_PORT = 5173
const WEB = `http://localhost:${WEB_PORT}`

// ---------------------------------------------------------------- utilidades

function leerEnv(archivo) {
  const env = {}
  for (const linea of readFileSync(archivo, 'utf-8').split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return env
}

const procesos = []

function iniciar(comando, cwd, nombre) {
  const proc = spawn(comando, { cwd, shell: true, detached: process.platform !== 'win32' })
  proc.salida = ''
  const guardar = (d) => (proc.salida = (proc.salida + d.toString()).slice(-4000))
  proc.stdout.on('data', guardar)
  proc.stderr.on('data', guardar)
  proc.nombre = nombre
  procesos.push(proc)
  return proc
}

function ejecutar(comando, cwd) {
  return new Promise((resolve) => {
    const proc = spawn(comando, { cwd, shell: true })
    let salida = ''
    proc.stdout.on('data', (d) => (salida += d))
    proc.stderr.on('data', (d) => (salida += d))
    proc.on('close', (code) => resolve({ code, salida }))
  })
}

async function detenerTodo() {
  for (const proc of procesos) {
    if (proc.exitCode !== null) continue
    if (process.platform === 'win32') {
      await ejecutar(`taskkill /pid ${proc.pid} /T /F`, ROOT)
    } else {
      try {
        process.kill(-proc.pid, 'SIGKILL')
      } catch {}
    }
  }
}

async function responde(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

async function esperar(url, ms) {
  const limite = Date.now() + ms
  while (Date.now() < limite) {
    if (await responde(url)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

// ---------------------------------------------------------------- preparación

if (!existsSync(path.join(BACKEND, 'package.json')) || !existsSync(path.join(FRONTEND, 'package.json'))) {
  console.error(`No se encontró backend/ y frontend/ en ${ROOT}`)
  process.exit(2)
}
if (!existsSync(path.join(BACKEND, '.env'))) {
  console.error('Falta backend/.env (cópialo de backend/.env.example y completa las credenciales).')
  process.exit(2)
}
if (!existsSync(path.join(FRONTEND, '.env'))) {
  copyFileSync(path.join(FRONTEND, '.env.example'), path.join(FRONTEND, '.env'))
  console.log('frontend/.env no existía: se creó a partir de .env.example')
}

const env = leerEnv(path.join(BACKEND, '.env'))
const API_PORT = Number(env.PORT || 3000)
const API = `http://localhost:${API_PORT}/api`

for (const [url, nombre] of [[`http://localhost:${API_PORT}`, 'backend'], [WEB, 'frontend']]) {
  if (await responde(url)) {
    console.error(`Ya hay algo escuchando en ${url} (${nombre}). Detén los servidores del alumno y vuelve a ejecutar.`)
    process.exit(2)
  }
}

console.log(`Proyecto: ${ROOT}\n`)
console.log('Instalando dependencias…')
for (const dir of [BACKEND, FRONTEND]) {
  const r = await ejecutar('pnpm install --frozen-lockfile', dir)
  if (r.code !== 0) {
    const r2 = await ejecutar('pnpm install', dir)
    if (r2.code !== 0) {
      console.error(`pnpm install falló en ${dir}\n${r2.salida}`)
      process.exit(2)
    }
  }
}

console.log('Reiniciando la base de datos (pnpm db:setup)…')
const seed = await ejecutar('pnpm db:setup', BACKEND)
if (seed.code !== 0) {
  console.error(`pnpm db:setup falló:\n${seed.salida}`)
  process.exit(2)
}

console.log('Levantando backend y frontend…')
const backend = iniciar('pnpm exec tsx --env-file=.env src/index.ts', BACKEND, 'backend')
const frontend = iniciar(`pnpm exec vite --port ${WEB_PORT} --strictPort`, FRONTEND, 'frontend')
const backendArriba = await esperar(`http://localhost:${API_PORT}/`, 40000)
const frontendArriba = await esperar(WEB, 40000)

const secret = env.JWT_SECRET
const usuarios = {
  admin: { id: 1, nombre: 'Administrador', email: 'admin@biblioteca.com', rol: 'ADMIN' },
  ana: { id: 2, nombre: 'Ana Torres', email: 'ana@biblioteca.com', rol: 'MIEMBRO' },
}
const base64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
function token(u) {
  const ahora = Math.floor(Date.now() / 1000)
  const header = base64url({ alg: 'HS256', typ: 'JWT' })
  const payload = base64url({ id: u.id, email: u.email, role: u.rol, iat: ahora, exp: ahora + 3600 })
  const firma = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${firma}`
}
const TOKEN_ADMIN = token(usuarios.admin)
const TOKEN_ANA = token(usuarios.ana)

async function http(metodo, ruta, { body, auth, headers = {} } = {}) {
  const res = await fetch(`${API}${ruta}`, {
    method: metodo,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  })
  let data = null
  try {
    data = await res.json()
  } catch {}
  return { status: res.status, data, headers: res.headers }
}

// ---------------------------------------------------------------- navegador

async function abrirNavegador() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel })
    } catch {}
  }
  try {
    return await chromium.launch()
  } catch {}
  console.log('No se encontró Chrome ni Edge: descargando Chromium dentro de la carpeta del verificador…')
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js')
  const r = await ejecutar(`node "${cli}" install chromium`, __dirname)
  if (r.code !== 0) throw new Error(`No se pudo instalar Chromium:\n${r.salida}`)
  return chromium.launch()
}

const browser = frontendArriba ? await abrirNavegador() : null

const CORS = {
  'access-control-allow-origin': WEB,
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}
const ruta = (sufijo) => (url) => new URL(url).pathname.endsWith(sufijo)

async function nuevaPagina(usuario) {
  const context = await browser.newContext()
  if (usuario) {
    const estado = { state: { token: token(usuario), usuario, isAuthenticated: true }, version: 0 }
    await context.addInitScript((valor) => localStorage.setItem('auth-storage', valor), JSON.stringify(estado))
  }
  const page = await context.newPage()
  page.setDefaultTimeout(6000)
  return { page, context, token: usuario ? token(usuario) : null }
}

async function responderMock(route, status, json) {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
  return route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(json) })
}

function libroFalso(id, title) {
  return { id, title, author: 'Autor de prueba', category: 'Novela', year: 2000, stock: 3 }
}

// ---------------------------------------------------------------- verificaciones

const checks = [
  {
    id: 1,
    area: 'Frontend',
    titulo: 'Axios usa la URL del API definida en .env',
    navegador: true,
    run: async () => {
      const { page, context } = await nuevaPagina(null)
      let urlLogin = null
      await page.route(ruta('/auth/login'), (r) => {
        if (r.request().method() === 'POST') urlLogin = r.request().url()
        return responderMock(r, 200, { token: TOKEN_ANA, usuario: usuarios.ana })
      })
      await page.goto(`${WEB}/login`)
      await page.getByLabel('Correo').fill('ana@biblioteca.com')
      await page.getByLabel('Contraseña').fill('miembro123')
      await page.getByRole('button', { name: 'Iniciar sesión' }).click()
      await page.waitForTimeout(1500)
      await context.close()
      const esperado = `${API}/auth/login`
      return { ok: urlLogin === esperado, detalle: `petición a ${urlLogin ?? '(ninguna)'}; se esperaba ${esperado}` }
    },
  },
  {
    id: 2,
    area: 'Backend',
    titulo: 'CORS permite el origen del frontend',
    run: async () => {
      const r = await http('OPTIONS', '/books', {
        headers: {
          Origin: WEB,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,authorization',
        },
      })
      const origen = r.headers.get('access-control-allow-origin')
      return { ok: origen === WEB || origen === '*', detalle: `Access-Control-Allow-Origin: ${origen}` }
    },
  },
  {
    id: 3,
    area: 'Backend',
    titulo: 'POST /api/auth/login recibe el body JSON',
    run: async () => {
      const r = await http('POST', '/auth/login', { body: { email: 'ana@biblioteca.com', password: 'miembro123' } })
      const ok = r.status === 200 && typeof r.data?.token === 'string' && r.data?.usuario?.rol === 'MIEMBRO'
      return { ok, detalle: `status ${r.status}` }
    },
  },
  {
    id: 4,
    area: 'Frontend',
    titulo: 'Las rutas protegidas renderizan su contenido',
    navegador: true,
    run: async () => {
      const { page, context } = await nuevaPagina(usuarios.ana)
      await page.route(ruta('/books'), (r) =>
        responderMock(r, 200, { data: [libroFalso(1, 'Libro uno')], total: 1, page: 1, totalPages: 1 })
      )
      await page.goto(`${WEB}/`)
      const ok = await page
        .getByRole('heading', { name: 'Catálogo' })
        .waitFor()
        .then(() => true)
        .catch(() => false)
      await context.close()
      return { ok, detalle: ok ? 'el catálogo se muestra con sesión iniciada' : 'la página queda en blanco' }
    },
  },
  {
    id: 5,
    area: 'Frontend',
    titulo: 'El token de la sesión viaja en el header Authorization',
    navegador: true,
    requiere: [4],
    run: async () => {
      const { page, context, token: esperado } = await nuevaPagina(usuarios.ana)
      let header
      await page.route(ruta('/loans/me'), async (r) => {
        if (r.request().method() === 'GET') header = (await r.request().allHeaders()).authorization ?? null
        return responderMock(r, 200, [])
      })
      await page.goto(`${WEB}/prestamos`)
      await page.waitForTimeout(2000)
      await context.close()
      const ok = header === `Bearer ${esperado}`
      return { ok, detalle: header === undefined ? 'no se pidió /loans/me' : `Authorization: ${header ? header.slice(0, 20) + '…' : '(vacío)'}` }
    },
  },
  {
    id: 6,
    area: 'Backend',
    titulo: 'GET /api/loans/me devuelve los préstamos del usuario',
    run: async () => {
      const r = await http('GET', '/loans/me', { auth: TOKEN_ANA })
      const ok = r.status === 200 && Array.isArray(r.data) && r.data.length === 2 && r.data.every((l) => l.user_id === 2)
      return { ok, detalle: `status ${r.status}${Array.isArray(r.data) ? `, ${r.data.length} préstamos` : ''}` }
    },
  },
  {
    id: 7,
    area: 'Frontend',
    titulo: 'Cambiar de página recarga el catálogo',
    navegador: true,
    requiere: [4],
    run: async () => {
      const { page, context } = await nuevaPagina(usuarios.ana)
      await page.route(ruta('/books'), (r) => {
        const p = Number(new URL(r.request().url()).searchParams.get('page')) || 1
        const data = [1, 2, 3].map((i) => libroFalso(p * 10 + i, `Libro página ${p} número ${i}`))
        return responderMock(r, 200, { data, total: 24, page: p, totalPages: 3 })
      })
      await page.goto(`${WEB}/?page=1`)
      let ok = false
      try {
        await page.getByText('Libro página 1 número 1').waitFor()
        await page.getByRole('button', { name: /Siguiente/ }).click()
        await page.getByText('Libro página 2 número 1').waitFor({ timeout: 4000 })
        ok = true
      } catch {}
      await context.close()
      return { ok, detalle: ok ? 'la página 2 muestra otros libros' : 'la lista no cambia al pasar de página' }
    },
  },
  {
    id: 8,
    area: 'Backend',
    titulo: 'La búsqueda usa consultas parametrizadas',
    run: async () => {
      const a = await http('GET', `/books?search=${encodeURIComponent("O'Connor")}`)
      const b = await http('GET', `/books?search=${encodeURIComponent("' OR '1'='1")}`)
      const ok = a.status === 200 && a.data?.total === 1 && b.status === 200 && b.data?.total === 0
      return { ok, detalle: `"O'Connor" → ${a.status} (${a.data?.total ?? '-'} resultados); inyección → ${b.status} (${b.data?.total ?? '-'} resultados)` }
    },
  },
  {
    id: 9,
    area: 'Frontend',
    titulo: 'El formulario de préstamo envía los días como número',
    navegador: true,
    requiere: [4],
    run: async () => {
      const { page, context } = await nuevaPagina(usuarios.ana)
      let body
      await page.route(ruta('/books/1'), (r) => responderMock(r, 200, libroFalso(1, 'Libro uno')))
      await page.route(ruta('/loans'), (r) => {
        if (r.request().method() === 'POST') body = r.request().postDataJSON()
        return responderMock(r, 201, {
          id: 99, user_id: 2, book_id: 1, title: 'Libro uno', author: 'Autor de prueba',
          loan_date: '2026-01-01', due_date: '2026-01-06', returned_at: null,
        })
      })
      await page.goto(`${WEB}/libros/1`)
      try {
        await page.getByLabel('Días de préstamo').fill('5')
        await page.getByRole('button', { name: 'Pedir prestado' }).click()
        await page.waitForTimeout(1500)
      } catch {}
      await context.close()
      const ok = body?.days === 5 && body?.bookId === 1
      return { ok, detalle: body ? `body enviado: ${JSON.stringify(body)}` : 'el formulario no envió la petición' }
    },
  },
  {
    id: 10,
    area: 'Backend',
    titulo: 'Un libro inválido se rechaza con 400 y no se guarda',
    run: async () => {
      const r = await http('POST', '/books', {
        auth: TOKEN_ADMIN,
        body: { title: '', author: 'Autor Verificador', category: 'Novela', stock: 2 },
      })
      await new Promise((res) => setTimeout(res, 300))
      const busqueda = await http('GET', `/books?search=${encodeURIComponent('Autor Verificador')}`)
      const guardado = busqueda.data?.total ?? '?'
      return { ok: r.status === 400 && guardado === 0, detalle: `status ${r.status}; libros guardados: ${guardado}` }
    },
  },
]

const regresiones = [
  ['POST /api/books sin token → 401', async () => (await http('POST', '/books', { body: {} })).status === 401],
  ['POST /api/books con rol MIEMBRO → 403', async () =>
    (await http('POST', '/books', { auth: TOKEN_ANA, body: { title: 'X', author: 'Y', category: 'Z', stock: 1 } })).status === 403],
  ['POST /api/books válido con ADMIN → 201', async () => {
    const r = await http('POST', '/books', { auth: TOKEN_ADMIN, body: { title: 'Rebelión en la granja', author: 'George Orwell', category: 'Novela', year: 1945, stock: 3 } })
    return r.status === 201 && typeof r.data?.id === 'number'
  }],
  ['GET /api/books/9999 → 404', async () => (await http('GET', '/books/9999')).status === 404],
  ['GET /api/books pagina de 8 en 8 sin saltarse libros', async () => {
    const todos = (await http('GET', '/books?limit=50')).data
    const ids = []
    for (let p = 1; p <= Math.ceil(todos.total / 8); p++) {
      const r = await http('GET', `/books?page=${p}&limit=8`)
      ids.push(...r.data.data.map((b) => b.id))
    }
    return ids.join() === todos.data.map((b) => b.id).join()
  }],
  ['GET /api/loans/1 (préstamo propio) → 200', async () => (await http('GET', '/loans/1', { auth: TOKEN_ANA })).status === 200],
  ['GET /api/loans/3 (préstamo ajeno) → 404', async () => (await http('GET', '/loans/3', { auth: TOKEN_ANA })).status === 404],
  ['POST /api/loans con 30 días → 400', async () =>
    (await http('POST', '/loans', { auth: TOKEN_ANA, body: { bookId: 1, days: 30 } })).status === 400],
  ['POST /api/loans de un libro sin ejemplares → 409', async () =>
    (await http('POST', '/loans', { auth: TOKEN_ANA, body: { bookId: 3, days: 7 } })).status === 409],
  ['POST /api/loans válido → 201 y descuenta un ejemplar', async () => {
    const r = await http('POST', '/loans', { auth: TOKEN_ANA, body: { bookId: 1, days: 7 } })
    const libro = await http('GET', '/books/1')
    return r.status === 201 && libro.data?.stock === 2
  }],
  ['POST /api/auth/login con contraseña incorrecta → 401', async () =>
    (await http('POST', '/auth/login', { body: { email: 'ana@biblioteca.com', password: 'incorrecta' } })).status === 401, 3],
]

// ---------------------------------------------------------------- ejecución

const resultados = new Map()
try {
  for (const check of checks) {
    let resultado
    const bloqueante = (check.requiere ?? []).find((id) => resultados.get(id)?.estado !== 'ok')
    if (check.navegador && !frontendArriba) {
      resultado = { estado: 'error', detalle: 'el frontend no arrancó' }
    } else if (!check.navegador && !backendArriba) {
      resultado = { estado: 'error', detalle: 'el backend no arrancó' }
    } else if (bloqueante) {
      resultado = { estado: 'bloqueado', detalle: `no se puede verificar hasta corregir #${bloqueante}` }
    } else {
      try {
        const { ok, detalle } = await check.run()
        resultado = { estado: ok ? 'ok' : 'falla', detalle }
      } catch (error) {
        resultado = { estado: 'falla', detalle: String(error.message ?? error).split('\n')[0] }
      }
    }
    resultados.set(check.id, resultado)
  }

  const regresionesOk = []
  if (backendArriba) {
    for (const [nombre, run, requiere] of regresiones) {
      if (requiere && resultados.get(requiere)?.estado !== 'ok') {
        regresionesOk.push([nombre, null, requiere])
        continue
      }
      let ok = false
      try {
        ok = await run()
      } catch {}
      regresionesOk.push([nombre, ok])
    }
  }

  console.log('\nCompilando TypeScript…')
  const tscBack = await ejecutar('pnpm exec tsc --noEmit', BACKEND)
  const tscFront = await ejecutar('pnpm exec tsc -b', FRONTEND)

  // ---------------------------------------------------------------- reporte
  const icono = { ok: '✅', falla: '❌', bloqueado: '⏸️ ', error: '⚠️ ' }
  console.log('\n═══ Errores de la prueba ═══════════════════════════════════════════════')
  for (const check of checks) {
    const r = resultados.get(check.id)
    console.log(`${icono[r.estado]} #${String(check.id).padEnd(2)} ${check.area.padEnd(8)} ${check.titulo}`)
    if (r.estado !== 'ok') console.log(`        ${r.detalle}`)
  }

  console.log('\n═══ Regresiones (cosas que ya funcionaban y deben seguir funcionando) ══')
  if (!backendArriba) console.log('⚠️  el backend no arrancó')
  for (const [nombre, ok, requiere] of regresionesOk) {
    if (ok === null) console.log(`⏸️  ${nombre} (no se puede verificar hasta corregir #${requiere})`)
    else console.log(`${ok ? '✅' : '❌'} ${nombre}`)
  }

  console.log('\n═══ Compilación ════════════════════════════════════════════════════════')
  console.log(`${tscBack.code === 0 ? '✅' : '❌'} backend:  tsc --noEmit`)
  console.log(`${tscFront.code === 0 ? '✅' : '❌'} frontend: tsc -b`)

  const corregidos = [...resultados.values()].filter((r) => r.estado === 'ok').length
  const regOk = regresionesOk.filter(([, ok]) => ok).length
  console.log('\n────────────────────────────────────────────────────────────────────────')
  console.log(`Errores corregidos: ${corregidos}/${checks.length}`)
  const regBloqueadas = regresionesOk.filter(([, ok]) => ok === null).length
  console.log(
    `Regresiones sin romper: ${regOk}/${regresiones.length}` +
      (regBloqueadas ? ` (${regBloqueadas} sin verificar)` : '')
  )
  console.log('\nAl terminar puedes borrar la carpeta del verificador: no deja nada instalado fuera de ella.')

  if (!backendArriba) console.log(`\nSalida del backend:\n${backend.salida}`)
  if (!frontendArriba) console.log(`\nSalida del frontend:\n${frontend.salida}`)

  process.exitCode = corregidos === checks.length && regOk === regresiones.length ? 0 : 1
} finally {
  await browser?.close()
  await detenerTodo()
}
