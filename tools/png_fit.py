#!/usr/bin/env python3
"""Resize an image to a Chrome Web Store asset slot.
Outputs 24-bit PNG (no alpha) by default — flattens transparency onto a
background. Pads (contain) or crops (cover) to hit exact target dimensions
without distorting aspect ratio. Never upscales content beyond source for
'contain' (keeps captures crisp; padding fills the rest).

Usage: make_asset.py SRC DST TW TH [contain|cover] [auto|white|black|R,G,B] [rgb|rgba]
"""
import sys, zlib, struct

def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', "not a PNG"
    pos, W=H=BD=CT=IL = 8, None
    W=H=BD=CT=IL=None
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack('>I', data[pos:pos+4])
        ctype = data[pos+4:pos+8]; cdata = data[pos+8:pos+8+length]
        pos += 12 + length
        if ctype == b'IHDR':
            W,H,BD,CT,_,_,IL = struct.unpack('>IIBBBBB', cdata)
        elif ctype == b'IDAT': idat += cdata
        elif ctype == b'IEND': break
    assert BD == 8 and IL == 0 and CT in (2,6), f"unsupported PNG (bd={BD} ct={CT} il={IL})"
    ch = 4 if CT == 6 else 3
    raw = zlib.decompress(bytes(idat))
    stride = W*ch
    rgba = bytearray(W*H*4)
    prev = bytearray(stride); pos = 0
    for y in range(H):
        ft = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos+stride]); pos += stride
        if ft == 1:
            for i in range(ch, stride): line[i]=(line[i]+line[i-ch])&255
        elif ft == 2:
            for i in range(stride): line[i]=(line[i]+prev[i])&255
        elif ft == 3:
            for i in range(stride):
                a=line[i-ch] if i>=ch else 0
                line[i]=(line[i]+((a+prev[i])>>1))&255
        elif ft == 4:
            for i in range(stride):
                a=line[i-ch] if i>=ch else 0; c=prev[i-ch] if i>=ch else 0
                p=a+prev[i]-c; pa=abs(p-a); pb=abs(p-prev[i]); pc=abs(p-c)
                pr=a if (pa<=pb and pa<=pc) else (prev[i] if pb<=pc else c)
                line[i]=(line[i]+pr)&255
        o=y*W*4
        if ch==4: rgba[o:o+stride]=line
        else:
            for x in range(W):
                s=x*3; d=o+x*4
                rgba[d]=line[s]; rgba[d+1]=line[s+1]; rgba[d+2]=line[s+2]; rgba[d+3]=255
        prev=line
    return W,H,rgba

def weights(insz, outsz):
    scale = insz/outsz
    out=[]
    if scale >= 1.0:  # downscale -> area average
        for i in range(outsz):
            a=i*scale; b=(i+1)*scale; s=int(a); c=[]
            while s<b:
                ov=min(b,s+1)-max(a,s)
                if ov>1e-9: c.append((s,ov))
                s+=1
            tot=sum(w for _,w in c) or 1.0
            out.append([(s,w/tot) for s,w in c])
    else:  # upscale -> linear 2-tap
        for i in range(outsz):
            ctr=(i+0.5)*scale-0.5; l=int(ctr) if ctr>=0 else -1; f=ctr-l
            l0=min(max(l,0),insz-1); l1=min(max(l+1,0),insz-1)
            if l0==l1: out.append([(l0,1.0)])
            else: out.append([(l0,1-f),(l1,f)])
    return out

def resample(sw,sh,src,ow,oh):
    xw=weights(sw,ow); yw=weights(sh,oh)
    out=bytearray(ow*oh*4); row=sw*4
    for oy in range(oh):
        ys=yw[oy]
        for ox in range(ow):
            xs=xw[ox]; tw=aA=rA=gA=bA=0.0
            for sy,wy in ys:
                base=sy*row
                for sx,wx in xs:
                    w=wy*wx; idx=base+sx*4; A=src[idx+3]; wa=w*A
                    tw+=w; aA+=wa; rA+=src[idx]*wa; gA+=src[idx+1]*wa; bA+=src[idx+2]*wa
            d=(oy*ow+ox)*4
            outA=aA/tw if tw else 0.0
            if aA>0:
                out[d]=min(255,max(0,int(rA/aA+0.5))); out[d+1]=min(255,max(0,int(gA/aA+0.5))); out[d+2]=min(255,max(0,int(bA/aA+0.5)))
            out[d+3]=min(255,max(0,int(outA+0.5)))
    return out

def auto_bg(W,H,px):
    pts=[(2,2),(W-3,2),(W//2,2),(2,H//2),(W-3,H//2)]
    cols=[]
    for x,y in pts:
        i=(y*W+x)*4
        if px[i+3]>250: cols.append((px[i],px[i+1],px[i+2]))
    if not cols: return (255,255,255)
    n=len(cols)
    return tuple(sum(c[k] for c in cols)//n for k in range(3))

def write_png(path,W,H,buf,ch):
    def chunk(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    ct = 6 if ch==4 else 2
    ihdr=struct.pack('>IIBBBBB',W,H,8,ct,0,0,0)
    stride=W*ch; raw=bytearray()
    for y in range(H):
        raw.append(0); raw+=buf[y*stride:(y+1)*stride]
    idat=zlib.compress(bytes(raw),9)
    with open(path,'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n'); f.write(chunk(b'IHDR',ihdr)); f.write(chunk(b'IDAT',idat)); f.write(chunk(b'IEND',b''))

def main():
    src,dst,tw,th = sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4])
    fit = sys.argv[5] if len(sys.argv)>5 else 'contain'
    bgarg = sys.argv[6] if len(sys.argv)>6 else 'auto'
    fmt = sys.argv[7] if len(sys.argv)>7 else 'rgb'
    sw,sh,src_px = read_png(src)
    bg = auto_bg(sw,sh,src_px) if bgarg=='auto' else ((255,255,255) if bgarg=='white' else (0,0,0) if bgarg=='black' else tuple(int(v) for v in bgarg.split(',')))
    # contain: never upscale — cap at 1.0 so small images keep native size and
    # get white/dark border padding instead of being stretched.
    sc = max(tw/sw, th/sh) if fit=='cover' else min(tw/sw, th/sh, 1.0)
    cw,ch = max(1,round(sw*sc)), max(1,round(sh*sc))
    content = resample(sw,sh,src_px,cw,ch)
    outch = 4 if fmt=='rgba' else 3
    out = bytearray(b'\x00'*(tw*th*outch))
    if outch==3:
        for i in range(0,tw*th*3,3): out[i]=bg[0]; out[i+1]=bg[1]; out[i+2]=bg[2]
    ox=(tw-cw)//2; oy=(th-ch)//2
    for y in range(ch):
        ty=y+oy
        if ty<0 or ty>=th: continue
        for x in range(cw):
            txp=x+ox
            if txp<0 or txp>=tw: continue
            si=(y*cw+x)*4; A=content[si+3]
            if outch==4:
                d=(ty*tw+txp)*4; out[d]=content[si]; out[d+1]=content[si+1]; out[d+2]=content[si+2]; out[d+3]=A
            else:
                a=A/255.0; d=(ty*tw+txp)*3
                out[d]=int(content[si]*a+bg[0]*(1-a)+0.5); out[d+1]=int(content[si+1]*a+bg[1]*(1-a)+0.5); out[d+2]=int(content[si+2]*a+bg[2]*(1-a)+0.5)
    write_png(dst,tw,th,out,outch)
    print(f"{src}  {sw}x{sh} -> {dst}  {tw}x{th}  fit={fit} bg={bg} fmt={fmt} content={cw}x{ch}")

if __name__=='__main__': main()
