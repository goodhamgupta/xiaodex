// Keep globals_t access in C. doomtype.h intentionally gives `boolean` a
// different C++ representation, so interpreting this C-owned struct directly
// from input.cpp would use the wrong field offsets.
#include "global_data.h"
#include "p_inter.h"

extern unsigned int doomZoneSize;
extern unsigned int renderDrawsegOverflows;
extern unsigned int renderOpeningOverflows;
extern unsigned int renderVisspriteOverflows;
unsigned int Z_ZoneFreeMemory(void);
unsigned int Z_ZoneLargestFree(void);

int DoomCurrentEpisode(void)
{
    return _g ? _g->gameepisode : 0;
}

int DoomCurrentMap(void)
{
    return _g ? _g->gamemap : 0;
}

void DoomShowPhysicalPrompt(void)
{
    static const char prompt[] = "TILT + PRESS A";
    if (_g)
        _g->player.message = prompt;
}

int DoomPlayerX(void)
{
    return (_g && _g->player.mo) ? (_g->player.mo->x >> FRACBITS) : 0;
}

int DoomPlayerY(void)
{
    return (_g && _g->player.mo) ? (_g->player.mo->y >> FRACBITS) : 0;
}

unsigned int DoomPlayerAngle(void)
{
    return (_g && _g->player.mo) ? _g->player.mo->angle : 0;
}

int DoomPlayerState(void)
{
    return _g ? _g->player.playerstate : -1;
}

int DoomPlayerHealth(void)
{
    return _g ? _g->player.health : 0;
}

int DoomKillPlayer(void)
{
    if (!_g || !_g->player.mo || _g->player.playerstate != PST_LIVE)
        return 0;
    P_DamageMobj(_g->player.mo, NULL, NULL, 10000);
    return _g->player.playerstate == PST_DEAD;
}

unsigned int DoomZoneSize(void)
{
    return doomZoneSize;
}

unsigned int DoomZoneFree(void)
{
    return Z_ZoneFreeMemory();
}

unsigned int DoomZoneLargest(void)
{
    return Z_ZoneLargestFree();
}

unsigned int DoomDrawsegOverflows(void)
{
    return renderDrawsegOverflows;
}

unsigned int DoomOpeningOverflows(void)
{
    return renderOpeningOverflows;
}

unsigned int DoomVisspriteOverflows(void)
{
    return renderVisspriteOverflows;
}
