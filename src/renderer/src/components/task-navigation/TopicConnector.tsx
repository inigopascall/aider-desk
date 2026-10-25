import { ReactNode } from 'react';
import { clsx } from 'clsx';
import { MdKeyboardArrowDown, MdKeyboardArrowRight } from 'react-icons/md';

import { TopicConnectorPart } from './topic-map-rows';

/** Stroke width and end-dot diameter, in pixels: the same as the parent connector in the quick switcher. */
const STROKE = 1;
const DOT = 5;
const HALF = STROKE / 2;
/** Diameter of the circle around a topic's expand arrow, in pixels. */
const CIRCLE = 20;
/** Left padding of a topic row (`px-3`), in pixels. */
const TOPIC_PADDING_LEFT = 12;
/** Centre of the trunk, from the row's padding edge: the centre of the circle, nudged 1px right to sit under the caret's point. */
const TRUNK_X = TOPIC_PADDING_LEFT + CIRCLE / 2 + 1;
/**
 * Left edge of the titles, from the row's padding edge: in a topic row, the padding, the circle, the number column and
 * their gaps; in the rows under it, their `pl-[68px]`.
 */
const TITLE_X = 68;
/** Middle of the first line of the row's title: the top padding of topic and section rows (`py-1.5`, `pt-1.5`) plus half a line. */
const LINE_MIDDLE = 'calc(0.375rem + 0.5lh)';
/** Length of a branch: half the distance from the trunk to half an em left of the title. */
const BRANCH = `calc((${TITLE_X - TRUNK_X}px - 0.5em) / 2)`;

type TopicCaretProps = {
  expanded: boolean;
};

/** A topic's expand arrow in an unfilled circle, centred on the first line of the topic's title. */
export const TopicCaret = ({ expanded }: TopicCaretProps) => (
  <span className="relative shrink-0 text-xs" style={{ width: CIRCLE, height: '1lh' }}>
    <span
      className="absolute left-0 top-1/2 -translate-y-1/2 rounded-full border border-text-muted text-text-muted flex items-center justify-center"
      style={{ width: CIRCLE, height: CIRCLE }}
    >
      {expanded ? <MdKeyboardArrowDown className="w-3.5 h-3.5" /> : <MdKeyboardArrowRight className="w-3.5 h-3.5" />}
    </span>
  </span>
);

type TopicConnectorProps = {
  part: TopicConnectorPart;
};

const Trunk = ({ top = 0 }: { top?: number | string }) => (
  <span className="absolute bg-text-muted-dark" style={{ left: TRUNK_X - HALF, width: STROKE, top, bottom: 0 }} />
);

const EndDot = () => (
  <span
    className="absolute rounded-full bg-text-muted-dark"
    style={{ width: DOT, height: DOT, left: `calc(${TRUNK_X - DOT / 2}px + ${BRANCH})`, top: `calc(${LINE_MIDDLE} - ${DOT / 2}px)` }}
  />
);

/**
 * One row's piece of the connector from an expanded topic to its section titles, drawn over the row. The trunk drops from
 * the bottom of the topic's circle and runs down through every row to the last section title. A branch leaves it on the
 * middle of the first line of each section title and ends in a dot halfway to the title; the last branch is the
 * trunk turning right. Corners and junctions have no dot. Lengths in em and lh are at the title's font size.
 */
export const TopicConnector = ({ part }: TopicConnectorProps) => {
  let content: ReactNode;
  switch (part) {
    case 'start':
      content = <Trunk top={`calc(${LINE_MIDDLE} + ${CIRCLE / 2}px)`} />;
      break;
    case 'pass':
      content = <Trunk />;
      break;
    case 'branch':
      content = (
        <>
          <Trunk />
          <span
            className="absolute bg-text-muted-dark"
            style={{ left: TRUNK_X, width: BRANCH, top: `calc(${LINE_MIDDLE} - ${HALF}px)`, height: STROKE }}
          />
          <EndDot />
        </>
      );
      break;
    case 'end':
      content = (
        <>
          <span
            className="absolute border-solid border-text-muted-dark"
            style={{
              left: TRUNK_X - HALF,
              top: 0,
              height: `calc(${LINE_MIDDLE} + ${HALF}px)`,
              width: `calc(${BRANCH} + ${HALF}px)`,
              borderLeftWidth: STROKE,
              borderBottomWidth: STROKE,
            }}
          />
          <EndDot />
        </>
      );
      break;
  }

  return (
    <span aria-hidden="true" data-topic-connector={part} className={clsx('pointer-events-none absolute inset-0', part === 'start' ? 'text-xs' : 'text-2xs')}>
      {content}
    </span>
  );
};
