import { useState, useCallback, useEffect } from 'react';
import {
  Dropdown,
  DropdownList,
  MenuToggle,
  MenuToggleElement,
  ToggleGroup,
  ToggleGroupItem,
  Content,
  Divider
} from '@patternfly/react-core';
import { SunIcon, MoonIcon, AdjustIcon } from '@patternfly/react-icons';

export default function ThemeSelector() {
  const [theme, setTheme] = useState<'default' | 'felt'>(() => (localStorage.getItem('pf-theme') as 'default' | 'felt') || 'default');
  const [colorScheme, setColorScheme] = useState<'system' | 'light' | 'dark'>(() => (localStorage.getItem('pf-color-scheme') as 'system' | 'light' | 'dark') || 'dark');
  const [contrastMode, setContrastMode] = useState<'system' | 'default' | 'high-contrast' | 'glass'>(() => (localStorage.getItem('pf-contrast-mode') as 'system' | 'default' | 'high-contrast' | 'glass') || 'default');
  const [isOpen, setIsOpen] = useState(false);

  const applyThemeClasses = useCallback((t: string, cs: string, cm: string) => {
    const root = document.documentElement;

    root.classList.remove('pf-v6-theme-felt');
    if (t === 'felt') root.classList.add('pf-v6-theme-felt');

    let isDark: boolean;
    if (cs === 'system') {
      isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } else {
      isDark = cs === 'dark';
    }
    root.setAttribute('data-theme', isDark ? 'dark' : 'light');
    root.classList.toggle('pf-v6-theme-dark', isDark);

    root.classList.remove('pf-v6-theme-high-contrast', 'pf-v6-theme-glass');
    if (cm === 'high-contrast') {
      root.classList.add('pf-v6-theme-high-contrast');
    } else if (cm === 'glass') {
      root.classList.add('pf-v6-theme-glass');
    } else if (cm === 'system') {
      if (window.matchMedia('(prefers-contrast: more)').matches) {
        root.classList.add('pf-v6-theme-high-contrast');
      } else if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) {
        root.classList.add('pf-v6-theme-high-contrast');
      }
    }
  }, []);

  useEffect(() => {
    applyThemeClasses(theme, colorScheme, contrastMode);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleThemeChange = (t: 'default' | 'felt') => {
    setTheme(t);
    localStorage.setItem('pf-theme', t);
    applyThemeClasses(t, colorScheme, contrastMode);
  };

  const handleColorSchemeChange = (cs: 'system' | 'light' | 'dark') => {
    setColorScheme(cs);
    localStorage.setItem('pf-color-scheme', cs);
    applyThemeClasses(theme, cs, contrastMode);
  };

  const handleContrastChange = (cm: 'system' | 'default' | 'high-contrast' | 'glass') => {
    setContrastMode(cm);
    localStorage.setItem('pf-contrast-mode', cm);
    applyThemeClasses(theme, colorScheme, cm);
  };

  return (
    <Dropdown
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
        <MenuToggle
          ref={toggleRef}
          onClick={() => setIsOpen(!isOpen)}
          isExpanded={isOpen}
          variant="plain"
        >
          {colorScheme === 'dark' ? <MoonIcon /> : colorScheme === 'system' ? <AdjustIcon /> : <SunIcon />}
        </MenuToggle>
      )}
      popperProps={{ position: 'right' }}
    >
      <DropdownList>
        <div style={{ padding: '16px', minWidth: '280px' }}>
          <Content component="h4" style={{ marginBottom: '8px' }}>Theme</Content>
          <ToggleGroup aria-label="Theme">
            <ToggleGroupItem text="Default" isSelected={theme === 'default'} onChange={() => handleThemeChange('default')} />
            <ToggleGroupItem text="Project Felt" isSelected={theme === 'felt'} onChange={() => handleThemeChange('felt')} />
          </ToggleGroup>
          <Divider style={{ margin: '12px 0' }} />
          <Content component="h4" style={{ marginBottom: '8px' }}>Color scheme</Content>
          <ToggleGroup aria-label="Color scheme">
            <ToggleGroupItem text="System" isSelected={colorScheme === 'system'} onChange={() => handleColorSchemeChange('system')} />
            <ToggleGroupItem text="Light" isSelected={colorScheme === 'light'} onChange={() => handleColorSchemeChange('light')} />
            <ToggleGroupItem text="Dark" isSelected={colorScheme === 'dark'} onChange={() => handleColorSchemeChange('dark')} />
          </ToggleGroup>
          <Divider style={{ margin: '12px 0' }} />
          <Content component="h4" style={{ marginBottom: '8px' }}>Contrast mode</Content>
          <ToggleGroup aria-label="Contrast mode">
            <ToggleGroupItem text="System" isSelected={contrastMode === 'system'} onChange={() => handleContrastChange('system')} />
            <ToggleGroupItem text="Default" isSelected={contrastMode === 'default'} onChange={() => handleContrastChange('default')} />
            <ToggleGroupItem text="High contrast" isSelected={contrastMode === 'high-contrast'} onChange={() => handleContrastChange('high-contrast')} />
            <ToggleGroupItem text="Glass" isSelected={contrastMode === 'glass'} onChange={() => handleContrastChange('glass')} />
          </ToggleGroup>
        </div>
      </DropdownList>
    </Dropdown>
  );
}
