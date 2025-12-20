import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

const Layout: React.FC = () => {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="w-full h-full flex overflow-hidden" style={{ background: '#242730' }}>
      {/* Mobile hamburger */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="lg:hidden fixed top-3 left-3 z-50 p-2 rounded transition-colors"
        style={{ background: '#29323C', border: '1px solid #3A414C' }}
        aria-label="Toggle menu"
      >
        <div className="w-4 h-3 flex flex-col justify-between">
          <span 
            className="block h-0.5 transition-all" 
            style={{ 
              background: '#A0A7B4',
              transform: sidebarOpen ? 'rotate(45deg) translateY(5px)' : 'none'
            }} 
          />
          <span 
            className="block h-0.5 transition-all" 
            style={{ 
              background: '#A0A7B4',
              opacity: sidebarOpen ? 0 : 1
            }} 
          />
          <span 
            className="block h-0.5 transition-all" 
            style={{ 
              background: '#A0A7B4',
              transform: sidebarOpen ? 'rotate(-45deg) translateY(-5px)' : 'none'
            }} 
          />
        </div>
      </button>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="lg:hidden fixed inset-0 z-30"
          style={{ background: 'rgba(0, 0, 0, 0.6)' }}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed lg:relative top-0 left-0 h-full z-40
          w-64 shrink-0
          transform transition-transform duration-200
          lg:translate-x-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <Sidebar onNavigate={() => setSidebarOpen(false)} />
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 h-full overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
};

export default Layout;
