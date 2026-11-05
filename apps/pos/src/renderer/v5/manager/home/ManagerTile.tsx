import { useId, type JSX } from 'react';
import { Link } from 'react-router-dom';

import { Icon } from '../../../icons/Icon';
import type { IconName } from '../../../icons/registry';
import type { TileCount } from './tile-counts';
import './manager-home.css';

interface ManagerTileProps {
  to: string;
  icon: IconName;
  title: string;
  description: string;
  testId: string;
  /** RT-1193: one attention count; absent when zero, loading or failed. */
  count?: TileCount | null;
}

/**
 * RT-499 (G-6) — one link card on the manager home: a glyph, the screen's name
 * and one line saying what it is for, and when a read says something needs attention one count line (RT-1193). The whole card is the link. Its
 * accessible name is the title alone and the line is its description, so a
 * screen reader hears «إدارة الكاشير» and then why. Navigation only.
 */
export function ManagerTile({
  to,
  icon,
  title,
  description,
  testId,
  count = null,
}: Readonly<ManagerTileProps>): JSX.Element {
  const id = useId();
  return (
    <li>
      <Link
        className="v5-manager-tile"
        to={to}
        aria-labelledby={`${id}-title`}
        aria-describedby={count === null ? `${id}-line` : `${id}-line ${id}-count`}
        data-testid={testId}
      >
        <span className="v5-manager-tile__glyph">
          <Icon name={icon} />
        </span>
        <span id={`${id}-title`} className="v5-manager-tile__title">
          {title}
        </span>
        <span id={`${id}-line`} className="v5-manager-tile__line">
          {description}
        </span>
        {count === null ? null : (
          <span id={`${id}-count`} className="v5-manager-tile__count">
            <span className="v5-manager-tile__dot" aria-hidden="true" />
            <bdi className="v5-manager-tile__figure">{count.figure}</bdi>
            <span>{count.text}</span>
          </span>
        )}
      </Link>
    </li>
  );
}
