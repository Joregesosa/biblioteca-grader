# Verificador — Biblioteca Comunitaria

Revisa automáticamente tu solución de la prueba técnica: levanta tu backend y tu frontend, reinicia la base de datos con los datos de prueba y comprueba el comportamiento de la aplicación.

## Antes de empezar

- **Detén** tu backend y tu frontend (`Ctrl + C` en sus terminales). El verificador los levanta por su cuenta en los puertos 3000 y 5173.
- Tu proyecto debe tener `backend/.env` con las credenciales de PostgreSQL que usaste durante la prueba.
- Necesitas Google Chrome o Microsoft Edge instalado (Edge ya viene con Windows).

## Uso

Desde la carpeta que contiene tu proyecto:

```bash
git clone <url-de-este-repo> biblioteca-grader
cd biblioteca-grader
pnpm install
pnpm grade ../<carpeta-de-tu-proyecto>
```

Tarda uno o dos minutos. Al final verás un reporte como este:

```
Errores corregidos: 8/10
Regresiones sin romper: 11/11
```

- **Errores:** los problemas de la prueba que tu solución corrige.
- **Regresiones:** cosas que ya funcionaban y deben seguir funcionando. Si una falla, alguna corrección rompió otra parte.
- `⏸️` significa que esa verificación depende de otro error que todavía no está corregido.

> El verificador **borra y vuelve a crear** la base `biblioteca_db`. No afecta a ninguna otra base.

## Al terminar

Borra la carpeta `biblioteca-grader`. El verificador no instala nada fuera de ella: usa tu Chrome o Edge, y si no encuentra ninguno descarga Chromium dentro de `biblioteca-grader/.browsers`.
