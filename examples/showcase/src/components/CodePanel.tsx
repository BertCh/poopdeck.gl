import React from 'react';
import { Highlight, themes } from 'prism-react-renderer';

interface CodePanelProps {
  code: string;
  language?: string;
}

const CodePanel: React.FC<CodePanelProps> = ({ code, language = 'tsx' }) => {
  // Custom theme matching Kepler.gl colors
  const keplerTheme = {
    ...themes.nightOwl,
    plain: {
      color: '#A0A7B4',
      backgroundColor: '#242730',
    },
  };

  return (
    <div className="h-full overflow-auto custom-scrollbar" style={{ background: '#242730' }}>
      <Highlight theme={keplerTheme} code={code.trim()} language={language}>
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre className={`${className} p-3 text-xs leading-relaxed`} style={{ ...style, background: 'transparent' }}>
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })} className="table-row">
                <span className="table-cell pr-3 select-none text-right" style={{ color: '#6A7485', width: 24, fontSize: 10 }}>
                  {i + 1}
                </span>
                <span className="table-cell">
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({ token })} />
                  ))}
                </span>
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
};

export default CodePanel;
