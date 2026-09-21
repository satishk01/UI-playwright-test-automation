require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pipelineRoutes = require('./routes/pipeline');
const runsRoutes = require('./routes/runs');
const authCaptureRoutes = require('./routes/auth-capture');
const registriesRoutes = require('./routes/registries');
const presetsRoutes = require('./routes/presets');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// API routes
app.use('/api/pipeline', pipelineRoutes);
app.use('/api/runs', runsRoutes);
app.use('/api/auth-capture', authCaptureRoutes);
app.use('/api/registries', registriesRoutes);
app.use('/api/presets', presetsRoutes);

// Serve client in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`AutoTest Agent server running on port ${PORT}`);
});
