import { useState, useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { api, type GraphData } from '../lib/api';
import { useTheme } from '../lib/theme';

interface GraphProps {
  onSelectDocument: (path: string) => void;
}

// D3 simulation node type
interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  type: string;
  status?: string;
  linkCount: number;
}

// D3 simulation link type
interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  source: SimNode | string;
  target: SimNode | string;
}

/**
 * Graph - Force-directed graph visualization of document links
 * Uses D3.js for physics simulation and SVG rendering
 *
 * Key implementation notes:
 * - Uses ResizeObserver for proper flex container dimension tracking
 * - Resolves CSS variables to actual colors (CSS vars don't work reliably in SVG attributes)
 * - Hover effects fade non-connected nodes for visual focus
 */
export default function Graph({ onSelectDocument }: GraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const { theme, themeName } = useTheme();

  // Fetch graph data
  useEffect(() => {
    const fetchGraph = async () => {
      try {
        setLoading(true);
        const data = await api.getGraph();
        setGraphData(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load graph');
      } finally {
        setLoading(false);
      }
    };

    fetchGraph();
  }, []);

  // Handle resize with ResizeObserver for accurate flex container sizing
  // Depends on loading so it re-runs after loading state changes and container is mounted
  useEffect(() => {
    if (!containerRef.current) return;

    const updateDimensions = () => {
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        setDimensions({ width: Math.max(400, width), height: Math.max(300, height) });
      }
    };

    // Initial measurement
    updateDimensions();

    const resizeObserver = new ResizeObserver(updateDimensions);
    resizeObserver.observe(containerRef.current);

    return () => resizeObserver.disconnect();
  }, [loading]);

  // Render graph with D3
  // Re-renders when theme changes to update colors
  useEffect(() => {
    if (!graphData || !svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const { width, height } = dimensions;

    // Use theme colors directly (theme context provides actual color values)
    const colors = theme.colors;

    // Color scale by document type
    // Tags use a distinct amber color that works across themes
    const tagColor = '#d4a844'; // Warm amber - visible on dark backgrounds
    const colorScale: Record<string, string> = {
      task: colors.success,
      knowledge: colors.info,
      inbox: colors.warning,
      reminder: '#ff6b6b', // Red/salmon for time-sensitive
      project: colors.primary,
      context: colors.secondary,
      tag: tagColor,
      'tag-index': tagColor,
      query: colors.info,
      default: colors.muted,
    };

    const resolvedBorder = colors.border;
    const resolvedBackground = colors.background;
    const resolvedPrimary = colors.primary;
    const resolvedMuted = colors.muted;

    const getColor = (type: string) => colorScale[type] || colorScale.default;

    // Size scale based on link count
    const maxLinks = Math.max(...graphData.nodes.map(n => n.linkCount), 1);
    const sizeScale = d3.scaleSqrt()
      .domain([0, maxLinks])
      .range([4, 16]);

    // Create simulation nodes
    const nodes: SimNode[] = graphData.nodes.map(n => ({
      ...n,
      x: undefined,
      y: undefined,
    }));

    // Create simulation links
    const links: SimLink[] = graphData.links.map(l => ({
      source: l.source,
      target: l.target,
    }));

    // Create force simulation
    const simulation = d3.forceSimulation<SimNode>(nodes)
      .force('link', d3.forceLink<SimNode, SimLink>(links)
        .id(d => d.id)
        .distance(80)
        .strength(0.5))
      .force('charge', d3.forceManyBody().strength(-150))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide<SimNode>().radius(d => sizeScale(d.linkCount) + 5));

    // Create container group for zoom/pan
    const g = svg.append('g');

    // Add zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });

    svg.call(zoom);

    // Draw edges
    const link = g.append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(links)
      .enter()
      .append('line')
      .attr('stroke', resolvedBorder)
      .attr('stroke-opacity', 0.4)
      .attr('stroke-width', 1);

    // Draw nodes
    const node = g.append('g')
      .attr('class', 'nodes')
      .selectAll('circle')
      .data(nodes)
      .enter()
      .append('circle')
      .attr('r', d => sizeScale(d.linkCount))
      .attr('fill', d => getColor(d.type))
      .attr('stroke', resolvedBackground)
      .attr('stroke-width', 1.5)
      .attr('cursor', 'pointer')
      .on('click', (_, d) => {
        onSelectDocument(d.id);
      })
      .on('mouseover', function(_, d) {
        // Find connected node IDs
        const connectedIds = new Set<string>([d.id]);
        links.forEach(l => {
          const sourceId = (l.source as SimNode).id;
          const targetId = (l.target as SimNode).id;
          if (sourceId === d.id) connectedIds.add(targetId);
          if (targetId === d.id) connectedIds.add(sourceId);
        });

        // Highlight hovered node
        d3.select(this)
          .attr('stroke', resolvedPrimary)
          .attr('stroke-width', 2);

        // Fade non-connected nodes
        node.attr('opacity', n => connectedIds.has(n.id) ? 1 : 0.15);

        // Fade non-connected labels
        label.attr('opacity', n => connectedIds.has(n.id) ? 1 : 0.15);

        // Highlight connected edges, fade others
        link
          .attr('stroke-opacity', l =>
            (l.source as SimNode).id === d.id || (l.target as SimNode).id === d.id ? 1 : 0.05
          )
          .attr('stroke', l =>
            (l.source as SimNode).id === d.id || (l.target as SimNode).id === d.id
              ? resolvedPrimary
              : resolvedBorder
          );
      })
      .on('mouseout', function() {
        d3.select(this)
          .attr('stroke', resolvedBackground)
          .attr('stroke-width', 1.5);

        // Reset all nodes and labels
        node.attr('opacity', 1);
        label.attr('opacity', 1);

        link
          .attr('stroke-opacity', 0.4)
          .attr('stroke', resolvedBorder);
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .call(d3.drag<any, SimNode>()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }));

    // Add labels
    const label = g.append('g')
      .attr('class', 'labels')
      .selectAll('text')
      .data(nodes)
      .enter()
      .append('text')
      .text(d => d.label.length > 20 ? d.label.substring(0, 20) + '...' : d.label)
      .attr('font-size', '10px')
      .attr('fill', resolvedMuted)
      .attr('text-anchor', 'middle')
      .attr('dy', d => sizeScale(d.linkCount) + 12)
      .attr('pointer-events', 'none');

    // Update positions on simulation tick
    simulation.on('tick', () => {
      link
        .attr('x1', d => (d.source as SimNode).x!)
        .attr('y1', d => (d.source as SimNode).y!)
        .attr('x2', d => (d.target as SimNode).x!)
        .attr('y2', d => (d.target as SimNode).y!);

      node
        .attr('cx', d => d.x!)
        .attr('cy', d => d.y!);

      label
        .attr('x', d => d.x!)
        .attr('y', d => d.y!);
    });

    // Center view on initial render
    svg.call(zoom.transform, d3.zoomIdentity.translate(0, 0).scale(0.8));

    // Cleanup
    return () => {
      simulation.stop();
    };
  }, [graphData, dimensions, onSelectDocument, theme, themeName]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--term-muted)' }}>
        Loading graph...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--term-error)' }}>
        Error: {error}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 h-full relative overflow-hidden">
      {/* Legend */}
      <div
        className="absolute top-2 left-2 p-2 text-xs space-y-1 z-10"
        style={{ backgroundColor: 'var(--term-background)', border: '1px solid var(--term-border)' }}
      >
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'var(--term-success)' }} />
          <span style={{ color: 'var(--term-muted)' }}>Tasks</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'var(--term-info)' }} />
          <span style={{ color: 'var(--term-muted)' }}>Knowledge</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'var(--term-warning)' }} />
          <span style={{ color: 'var(--term-muted)' }}>Inbox</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#ff6b6b' }} />
          <span style={{ color: 'var(--term-muted)' }}>Reminders</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'var(--term-primary)' }} />
          <span style={{ color: 'var(--term-muted)' }}>Projects</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#d4a844' }} />
          <span style={{ color: 'var(--term-muted)' }}>Tags</span>
        </div>
      </div>

      {/* Controls */}
      <div
        className="absolute top-2 right-2 p-2 text-xs z-10"
        style={{ backgroundColor: 'var(--term-background)', border: '1px solid var(--term-border)', color: 'var(--term-muted)' }}
      >
        Scroll to zoom, drag to pan
      </div>

      {/* Graph SVG */}
      <svg
        ref={svgRef}
        width={dimensions.width}
        height={dimensions.height}
        style={{ backgroundColor: 'var(--term-background)' }}
      />

      {/* Stats */}
      {graphData && (
        <div
          className="absolute bottom-2 left-2 p-2 text-xs z-10"
          style={{ backgroundColor: 'var(--term-background)', border: '1px solid var(--term-border)', color: 'var(--term-muted)' }}
        >
          {graphData.nodes.length} nodes, {graphData.links.length} edges
        </div>
      )}
    </div>
  );
}
