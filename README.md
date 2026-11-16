# Casa · Energía

Panel para enchufes Tapo con medición de consumo (P110, P110M, P115…): consumo en directo sobre el plano de tu casa, historial que no se pierde y coste real con el precio PVPC de cada hora.

- Plano de la casa con editor de paredes y salas, y los enchufes colocados en él.
- Consumo en directo, con cables animados de cada enchufe a su tarjeta.
- Historial por meses, días y horas, guardado en SQLite o Postgres para no perder lo que el enchufe olvida.
- Coste real con PVPC (Red Eléctrica), reparto por periodos 2.0TD y consejos de horas baratas.
- Tema claro y oscuro, exportación a CSV.

## Primeros pasos

```bash
python -m venv venv
venv/Scripts/pip install -r requirements.txt     # en Linux/macOS: venv/bin/pip
cp .env.example .env                              # rellena TAPO_EMAIL y TAPO_PASSWORD
venv/Scripts/python -m app                        # http://127.0.0.1:8080
```

La primera vez se abre un asistente:

1. **Tu casa**: el nombre que aparece en la cabecera.
2. **Salas**: al menos una, con nombre, medidas y tipo (habitación, terraza o trastero).
3. **Enchufes**: búsqueda en la red o alta por IP. Se puede saltar.

Después, **Editar plano** permite mover paredes, añadir esquinas y dibujar salas con cualquier forma, y **Colocar enchufes** sitúa cada enchufe en su sala.

> No arranques dos instancias contra los mismos enchufes a la vez: si los sondean dos programas, responden mal.

## Configuración (`.env`)

| Variable | Para qué | Por defecto |
|---|---|---|
| `TAPO_EMAIL`, `TAPO_PASSWORD` | Cuenta de Tapo con la que se dieron de alta los enchufes | — |
| `HOST`, `PORT` | Dónde escucha; `0.0.0.0` para verlo desde la red | `127.0.0.1`, `8080` |
| `POLL_INTERVAL` | Segundos entre lecturas de los enchufes | `3` |
| `DATABASE_URL` | `postgresql://usuario:contraseña@host:5432/db`; vacío = SQLite | vacío |
| `SQLITE_PATH` | Nombre del archivo SQLite dentro de `DATA_DIR` | `consum.db` |
| `DATA_DIR` | Carpeta de datos: `plugs.json`, `plan.json` y SQLite | `data/` |
| `SYNC_MINUTES` | Cada cuánto se copia el historial a la base de datos | `15` |
| `POLL_TIMEOUT`, `REQUEST_TIMEOUT` | Esperas a los enchufes, en segundos; súbelas si su wifi es flojo | `15`, `45` |

## Docker

`docker-compose.yml` levanta la app (red del host, puerto 8090) y un Postgres accesible solo desde la propia máquina. La red del host hace falta para encontrar los enchufes por broadcast.

```bash
cp .env.example .env    # TAPO_EMAIL, TAPO_PASSWORD y además POSTGRES_PASSWORD
docker compose up -d --build
```

Para desplegar en otra máquina por SSH (sube `app/` y `web/` y reconstruye; no toca datos ni `.env`):

```bash
DEPLOY_HOST=usuario@servidor ./scripts/deploy.sh      # DEPLOY_DIR=~/apps/consum por defecto
```

## Qué guarda cada sitio

- **El enchufe** recuerda unos 7 días por horas, unos 90 por días y los totales mensuales. Un reset lo borra todo.
- **La base de datos** copia todo eso cada `SYNC_MINUTES` y no lo pierde. Las gráficas combinan ambas fuentes.
- **Los precios PVPC** se descargan de Red Eléctrica y se guardan en la base de datos. Son el término de energía de la 2.0TD: sin IVA, impuesto eléctrico ni término de potencia.

## Estructura

```
app/                 servidor (Python, aiohttp)
  server.py          rutas HTTP y API
  tapo.py            conexión y sondeo de los enchufes
  recorder.py        copia periódica del historial a la base de datos
  storage.py         SQLite o Postgres
  prices.py          precio PVPC y cálculo del coste
  config.py          rutas, .env y valores por defecto
web/                 interfaz (Vue 3 sin compilación)
  index.html
  assets/css/app.css
  assets/js/         geometry.js · format.js · chart.js · app.js
scripts/deploy.sh    despliegue por SSH
```
