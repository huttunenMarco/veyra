import { ImageOff } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { frameUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

export function Snapshot({ frameId, demo, className, alt = 'Kamerabild' }: { frameId: string | null | undefined; demo?: boolean; className?: string; alt?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className={cn('relative aspect-video overflow-hidden bg-muted', className)}>
      {frameId && !failed ? (
        <img
          key={frameId}
          src={frameUrl(frameId)}
          alt={alt}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn('h-full w-full object-cover transition-opacity', loaded ? 'opacity-100' : 'opacity-0')}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
          <ImageOff className="size-6" />
          <span className="text-xs">{failed ? 'Bilden har raderats' : 'Ingen bild ännu'}</span>
        </div>
      )}
      {frameId && !loaded && !failed && <div className="absolute inset-0 animate-pulse bg-muted" />}
      {demo && (
        <Badge variant="demo" className="absolute bottom-2 left-2">
          Demo
        </Badge>
      )}
    </div>
  );
}
