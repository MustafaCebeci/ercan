// routesDump.js
function listRoutes(router) {
    const out = [];

    for (const layer of router.stack) {
        if (!layer.route) continue;

        const path = layer.route.path;              // '/businesses/:id' gibi
        const methods = Object.keys(layer.route.methods)
            .filter((m) => layer.route.methods[m])
            .map((m) => m.toUpperCase());

        out.push({ path, methods });
    }

    return out;
}

module.exports = { listRoutes };
