/**
 * TensorFlow.js in the API — pure JavaScript (core + layers + CPU backend),
 * not tfjs-node: no native binary, ~3 MB of runtime code in the serverless
 * bundle. Loaded lazily on first use so a cold start never waits for it.
 */
let tf = null;
let tfl = null;
let ready = null;

function load() {
  if (!ready) {
    ready = (async () => {
      // tfjs prints a "consider tfjs-node" banner on first load; that is the
      // deliberate trade-off above, not a misconfiguration.
      tf = require('@tensorflow/tfjs-core');
      require('@tensorflow/tfjs-backend-cpu');
      tfl = require('@tensorflow/tfjs-layers');
      await tf.setBackend('cpu');
      await tf.ready();
      return { tf, tfl };
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

/** Build a LayersModel from an ml_model_artifacts document. */
async function modelFromArtifact(artifact) {
  const { tf: t, tfl: l } = await load();
  const weightData = new Uint8Array(Buffer.from(artifact.weightDataB64, 'base64')).buffer;
  return l.loadLayersModel(
    t.io.fromMemory({ modelTopology: artifact.modelTopology, weightSpecs: artifact.weightSpecs, weightData })
  );
}

/** Score a batch of standardised vectors → probabilities. */
async function predict(model, vectors) {
  const { tf: t } = await load();
  return t.tidy(() => Array.from(model.predict(t.tensor2d(vectors)).dataSync()));
}

module.exports = { load, modelFromArtifact, predict };
