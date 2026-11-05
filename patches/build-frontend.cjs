// Run from the web workspace after restoring its pinned development dependencies.
const fs = require("node:fs");
const path = require("node:path");
const webpack = require("webpack");
const pug = require("pug");
// Use native defaults, without importing the runtime's instance configuration.
const buildSettings = "/tmp/agent-webpack-settings.cjs";
fs.writeFileSync(buildSettings, "module.exports = {}\n");
process.env.OVERLEAF_CONFIG = buildSettings;
const config = require("./webpack.config.prod");

// Build all entrypoints together so their shared runtime and manifest agree.
config.output.path = "/opt/overleaf-agent/frontend-assets";
config.parallelism = 4;
for (const minimizer of config.optimization.minimizer) {
  if (minimizer.options && "parallel" in minimizer.options) {
    minimizer.options.parallel = 2;
  }
}

const view = path.resolve("modules/agent-access/app/views/index.pug");
fs.writeFileSync(
  view.replace(/\.pug$/, ".js"),
  pug.compileFileClient(view, {
    doctype: "html",
    cache: true,
    compileDebug: false,
    inlineRuntimeFunctions: false,
    module: true,
  }),
);

webpack(config, (error, stats) => {
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(
    stats.toString({ all: false, errors: true, warnings: true, timings: true }),
  );
  if (stats.hasErrors()) process.exitCode = 1;
});
