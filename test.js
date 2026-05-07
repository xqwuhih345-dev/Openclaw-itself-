/**
 * Quick brain connectivity test
 * Usage: node brain/test.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const brain = require('./ollama');

(async () => {
  console.log('\n🧠  Testing Ollama brain connection...\n');

  const available = await brain.isAvailable();
  if (!available) {
    console.error('❌  Ollama is not running at', process.env.OLLAMA_URL || 'http://localhost:11434');
    console.error('   Start it with: ollama serve');
    process.exit(1);
  }

  console.log('✅  Ollama is online\n');

  const models = await brain.listModels();
  console.log('📦  Available models:', models.join(', ') || 'none pulled yet');
  console.log(`   Configured model: ${process.env.OLLAMA_MODEL || 'llama3'}\n`);

  if (!models.length) {
    console.warn('⚠️   No models found. Pull one with: ollama pull llama3');
    process.exit(0);
  }

  console.log('💬  Testing think()...');
  const reply = await brain.think('Say "OpenClaw online" and nothing else.');
  console.log('   Response:', reply, '\n');

  console.log('📋  Testing plan()...');
  const plan = await brain.plan('Research top YouTube trends for today');
  console.log('   Plan:', JSON.stringify(plan, null, 2), '\n');

  console.log('✅  Brain test complete.\n');
})();
