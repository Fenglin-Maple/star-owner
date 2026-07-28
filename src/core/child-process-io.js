function utf8ChildEnvironment(environment = process.env) {
  return {
    ...environment,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  };
}

function readUtf8(stream, onData) {
  if (!stream) return stream;
  stream.setEncoding('utf8');
  stream.on('data', onData);
  return stream;
}

function nodeChildProcessSpec(environment = process.env) {
  const env = utf8ChildEnvironment(environment);
  if (process.versions?.electron) env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;
  return { executable: process.execPath, env };
}

module.exports = { nodeChildProcessSpec, readUtf8, utf8ChildEnvironment };
