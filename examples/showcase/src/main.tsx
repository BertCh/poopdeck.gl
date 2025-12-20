import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';
import DemoPage from './pages/DemoPage';
import FormatPage from './pages/FormatPage';
import LayersPage from './pages/LayersPage';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="format" element={<FormatPage />} />
          <Route path="layers" element={<LayersPage />} />
          <Route path="demo/:datasetId" element={<DemoPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
