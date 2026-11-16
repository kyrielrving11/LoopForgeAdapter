const nodePty = require('node-pty');
const extraArgs = JSON.parse(process.env.LOOPFORGE_EXPERIMENT_CLAUDE_ARGS ?? '[]');
if (process.argv.some((arg) => /dist[\\/]src[\\/]cli\.js$/i.test(arg))) {
  const spawn = nodePty.spawn;
  nodePty.spawn = (file, args, options) => spawn(file, [...args, ...extraArgs], options);
}
