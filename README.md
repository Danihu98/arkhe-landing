# Arkhé · página de venta (arkheapp.cl)

Página estática, sin build. Publicada el 2 de noviembre de 2026; la anterior quedó guardada en `web-venta/landing-anterior/` del repo privado.

La fuente es `web-venta/pagina/arkhe.html` del repo privado de Arkhé (el mismo archivo del Artifact de revisión, con las marcas internas para Dani). La versión pública se arma desde la raíz de ese repo con:

```
python -I web-venta/pagina/publicar_landing.py web-venta/pagina/arkhe.html web-venta/pagina/img landing
```

y se publica con `bash landing/publicar.sh` (GitHub Pages, repo `Danihu98/arkhe-landing`, dominio arkheapp.cl).

Al armarla se sacan las marcas internas ([REF n] y «[Pendiente: …]»), la fila del plan de seguridad (vuelve cuando la plantilla de la app traiga el \*4141) y la frase de la portada que falta confirmar, y vuelven los enlaces para compartir, que solo sirven en este dominio.

- Sin analytics ni cookies. El formulario guarda solo dentro del Artifact; aquí se ofrece el WhatsApp.
- Las láminas son de dominio público o CC0; fuentes y licencias en `web-venta/imagenes/FUENTES.md`.
- Todas las pantallas de la app son de un caso ficticio.
