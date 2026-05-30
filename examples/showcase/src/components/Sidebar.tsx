import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { DATASETS } from '../datasets';
import { Dataset } from '../types';

interface SidebarProps {
  onNavigate?: () => void;
}

const typeLabels: Record<string, string> = {
  point: 'Point Layers',
  path: 'Path Layers',
  trips: 'Animated Trips',
  vat: 'VAT Trips',
  heatmap: 'Heatmaps',
  polygon: 'Polygon Layers',
  summary: 'Summary Hex Bins',
};

const typeIcons: Record<string, string> = {
  point: '●',
  path: '〜',
  trips: '→',
  vat: '⇶',
  heatmap: '◐',
  polygon: '⬡',
  summary: '⬢',
};

const Sidebar: React.FC<SidebarProps> = ({ onNavigate }) => {
  const location = useLocation();

  const groupedDatasets = React.useMemo(() => {
    const groups: Record<string, Dataset[]> = {
      point: [],
      path: [],
      trips: [],
      vat: [],
      heatmap: [],
      polygon: [],
      summary: [],
    };
    DATASETS.forEach((dataset) => {
      if (groups[dataset.type]) groups[dataset.type].push(dataset);
    });
    return groups;
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: '#242730', borderRight: '1px solid #3A414C' }}>
      {/* Header */}
      <div className="shrink-0 p-4 border-b" style={{ background: '#29323C', borderColor: '#3A414C' }}>
        <NavLink to="/" onClick={onNavigate} className="block">
          <h1 className="text-lg font-bold" style={{ color: '#1FBAD6' }}>STT</h1>
          <p className="text-xs mt-0.5" style={{ color: '#6A7485' }}>SpatioTemporal Tiles</p>
        </NavLink>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto custom-scrollbar py-2">
        {/* Main Navigation */}
        <div className="px-2 mb-3">
          <NavLink
            to="/"
            onClick={onNavigate}
            className="flex items-center gap-2 px-3 py-2 rounded text-xs font-medium transition-colors"
            style={({ isActive }) => ({
              background: isActive ? 'rgba(31, 186, 214, 0.15)' : 'transparent',
              color: isActive ? '#1FBAD6' : '#A0A7B4',
              border: isActive ? '1px solid rgba(31, 186, 214, 0.3)' : '1px solid transparent',
            })}
          >
            <span>Home</span>
          </NavLink>
        </div>

        {/* Documentation Section */}
        <div className="mb-3">
          <h2 className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: '#6A7485' }}>
            Documentation
          </h2>
          <div className="px-2">
            <NavLink
              to="/layers"
              onClick={onNavigate}
              className="block px-3 py-2 rounded mb-0.5 transition-colors"
              style={({ isActive }) => ({
                background: isActive ? '#29323C' : 'transparent',
                borderLeft: isActive ? '2px solid #1FBAD6' : '2px solid transparent',
              })}
            >
              {({ isActive }) => (
                <>
                  <span className="block text-xs font-medium" style={{ color: isActive ? '#FFFFFF' : '#A0A7B4' }}>
                    Layers
                  </span>
                  <span className="block text-[10px] mt-0.5" style={{ color: '#6A7485' }}>
                    deck.gl layer reference
                  </span>
                </>
              )}
            </NavLink>
            <NavLink
              to="/format"
              onClick={onNavigate}
              className="block px-3 py-2 rounded mb-0.5 transition-colors"
              style={({ isActive }) => ({
                background: isActive ? '#29323C' : 'transparent',
                borderLeft: isActive ? '2px solid #1FBAD6' : '2px solid transparent',
              })}
            >
              {({ isActive }) => (
                <>
                  <span className="block text-xs font-medium" style={{ color: isActive ? '#FFFFFF' : '#A0A7B4' }}>
                    Format & Tools
                  </span>
                  <span className="block text-[10px] mt-0.5" style={{ color: '#6A7485' }}>
                    .stt file format & CLI
                  </span>
                </>
              )}
            </NavLink>
          </div>
        </div>

        {/* Dataset Groups */}
        {Object.entries(groupedDatasets).map(([type, datasets]) => {
          if (datasets.length === 0) return null;
          return (
            <div key={type} className="mb-3">
              <h2 className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: '#6A7485' }}>
                <span style={{ color: '#1FBAD6' }}>{typeIcons[type]}</span> {typeLabels[type]}
              </h2>
              <div className="px-2">
                {datasets.map((dataset) => {
                  const isActive = location.pathname === `/demo/${dataset.id}`;
                  return (
                    <NavLink
                      key={dataset.id}
                      to={`/demo/${dataset.id}`}
                      onClick={onNavigate}
                      className="block px-3 py-2 rounded mb-0.5 transition-colors"
                      style={{
                        background: isActive ? '#29323C' : 'transparent',
                        borderLeft: isActive ? '2px solid #1FBAD6' : '2px solid transparent',
                      }}
                      onMouseOver={(e) => { if (!isActive) e.currentTarget.style.background = '#29323C'; }}
                      onMouseOut={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <span className="block text-xs font-medium" style={{ color: isActive ? '#FFFFFF' : '#A0A7B4' }}>
                        {dataset.name}
                      </span>
                      <span className="block text-[10px] mt-0.5 line-clamp-1" style={{ color: '#6A7485' }}>
                        {dataset.description}
                      </span>
                    </NavLink>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="shrink-0 p-3 border-t" style={{ borderColor: '#3A414C' }}>
        <a
          href="https://github.com/your-org/spatiotemporal-tiles"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-3 py-2 rounded text-xs transition-colors"
          style={{ color: '#6A7485' }}
          onMouseOver={(e) => { e.currentTarget.style.background = '#29323C'; e.currentTarget.style.color = '#A0A7B4'; }}
          onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#6A7485'; }}
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
          </svg>
          GitHub
        </a>
      </div>
    </div>
  );
};

export default Sidebar;
