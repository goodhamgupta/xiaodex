// Xiaodex modification notice (2026-08-26): support a protected map arena and
// multiple non-contiguous internal-RAM zones; expose allocator diagnostics.
// Emacs style mode select   -*- C++ -*-
//-----------------------------------------------------------------------------
//
// $Id:$
//
// Copyright (C) 1993-1996 by id Software, Inc.
//
// This source is available for distribution and/or modification
// only under the terms of the DOOM Source Code License as
// published by id Software. All rights reserved.
//
// The source is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// FITNESS FOR A PARTICULAR PURPOSE. See the DOOM Source Code License
// for more details.
//
// $Log:$
//
// DESCRIPTION:
//	Zone Memory Allocation. Neat.
//
//-----------------------------------------------------------------------------

#include "z_zone.h"
#include "doomdef.h"
#include "doomtype.h"
#include "lprintf.h"
#include <stdint.h>
#ifdef ESP_PLATFORM
#include <esp_heap_caps.h>
#endif


//
// ZONE MEMORY ALLOCATION
//
// There is never any space between memblocks,
//  and there will never be two contiguous free memblocks.
// The rover can be left pointing at a non-empty block.
//
// It is of no value to free a cachable block,
//  because it will get overwritten automatically if needed.
//

#define ZONEID	0x1d4a11

const unsigned int maxHeapSize = (256 * 1024);
unsigned int doomZoneSize = 0;

#ifndef GBA
    static int running_count = 0;
#endif

typedef struct memblock_s
{
    unsigned int size:24;	// including the header and possibly tiny fragments
    unsigned int tag:4;	// purgelevel
    void**		user;	// NULL if a free block
    struct memblock_s*	next;
    struct memblock_s*	prev;
} memblock_t;


typedef struct
{
    // start / end cap for linked list
    memblock_t	blocklist;
    memblock_t*	rover;
} memzone_t;

memzone_t*	mainzone;

#define MAX_ZONES 8
static memzone_t* zones[MAX_ZONES];
static unsigned int zoneSizes[MAX_ZONES];
static int zoneCount;
static int levelZoneIndex = -1;

static void Z_InitZone(memzone_t* zone, unsigned int size)
{
    memblock_t* block;
    zone->blocklist.next =
    zone->blocklist.prev =
    block = (memblock_t*)((byte*)zone + sizeof(memzone_t));

    zone->blocklist.user = (void*)zone;
    zone->blocklist.tag = PU_STATIC;
    zone->rover = block;
    block->prev = block->next = &zone->blocklist;
    block->user = NULL;
    block->tag = 0;
    block->size = size - sizeof(memzone_t);
}

#ifdef ESP_PLATFORM
static memzone_t* Z_AllocZoneMemory(unsigned int* size, unsigned int minimum)
{
    memzone_t* memory = NULL;
    while (!memory && *size >= minimum)
    {
        memory = heap_caps_malloc(*size,
                                  MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        if (!memory)
            *size -= 1024;
    }
    return memory;
}

static void Z_AddZone(memzone_t* zone, unsigned int size)
{
    zones[zoneCount] = zone;
    zoneSizes[zoneCount] = size;
    zoneCount++;
    Z_InitZone(zone, size);
    doomZoneSize += size;
}
#endif

static memzone_t* Z_ZoneForPointer(const void* ptr)
{
    uintptr_t address = (uintptr_t)ptr;
    for (int i = 0; i < zoneCount; i++)
    {
        uintptr_t start = (uintptr_t)zones[i];
        if (address >= start && address < start + zoneSizes[i])
            return zones[i];
    }
    return NULL;
}

//
// Z_Init
//
void Z_Init (void)
{
#ifdef ESP_PLATFORM
    // The original ESP32 has enough total internal RAM for Doom, but it is
    // split into several non-contiguous heap regions. Take the largest block
    // once, carve a protected 64 KiB per-map arena from it, and use the tail
    // plus smaller regions for static and ordinary level data. Allocating the
    // two arenas separately makes the heap split the useful 110 KiB region.
    const unsigned int zoneBudget = 190 * 1024;
    // DisplayInit needs about 5 KiB of internal DMA memory. Keep a measured
    // 24 KiB reserve for it and the Arduino/SPI runtime while allowing the
    // map zones to use the otherwise stranded byte-addressable DRAM.
    const unsigned int systemReserve = 24 * 1024;
    const unsigned int levelSize = 64 * 1024;

    zoneCount = 0;
    doomZoneSize = 0;
    mainzone = NULL;

    unsigned int rawSize = heap_caps_get_largest_free_block(
        MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (rawSize > zoneBudget)
        rawSize = zoneBudget;
    memzone_t* raw = Z_AllocZoneMemory(&rawSize, levelSize + 8 * 1024);
    if (!raw)
        I_Error("Z_Init: cannot reserve split Doom heap");

    Z_AddZone(raw, levelSize);
    levelZoneIndex = 0;
    lprintf(LO_INFO,"Z_Init: reserved level heap is %d bytes.", levelSize);

    unsigned int firstGeneralSize = rawSize - levelSize;
    mainzone = (memzone_t*)((byte*)raw + levelSize);
    Z_AddZone(mainzone, firstGeneralSize);
    lprintf(LO_INFO,"Z_Init: general heap 1 is %d bytes.", firstGeneralSize);

    while (zoneCount < MAX_ZONES && doomZoneSize + 8 * 1024 <= zoneBudget)
    {
        unsigned int remaining = zoneBudget - doomZoneSize;
        unsigned int freeHeap = heap_caps_get_free_size(
            MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        if (freeHeap <= systemReserve + 8 * 1024)
            break;
        unsigned int available = freeHeap - systemReserve;
        unsigned int largest = heap_caps_get_largest_free_block(
            MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        unsigned int size = largest < remaining ? largest : remaining;
        if (size > available)
            size = available;
        memzone_t* memory = Z_AllocZoneMemory(&size, 8 * 1024);
        if (!memory)
            break;

        if (!mainzone)
            mainzone = memory;
        Z_AddZone(memory, size);
        lprintf(LO_INFO,"Z_Init: general heap %d is %d bytes.",
                zoneCount - 1, size);
    }

    if (!mainzone)
        I_Error("Z_Init: cannot reserve general heap");
    lprintf(LO_INFO,"Z_Init: total heap is %d bytes in %d zones.",
            doomZoneSize, zoneCount);
#else
    unsigned int heapSize = maxHeapSize;
    //We can now alloc all of the rest fo the memory.
    do
    {
        mainzone = malloc(heapSize);
        heapSize -= 4;

    } while(mainzone == NULL);

    heapSize += 4;

    lprintf(LO_INFO,"Z_Init: Heapsize is %d bytes.", heapSize);
    zones[0] = mainzone;
    zoneSizes[0] = heapSize;
    zoneCount = 1;
    Z_InitZone(mainzone, heapSize);
    doomZoneSize = heapSize;
#endif
}


//
// Z_Free
//
void Z_Free (void* ptr)
{
    memblock_t*		block;
    memblock_t*		other;

    if(ptr == NULL)
        return;

    memzone_t* zone = Z_ZoneForPointer(ptr);
    if (!zone)
        I_Error("Z_Free: pointer outside Doom zones");

    block = (memblock_t *) ( (byte *)ptr - sizeof(memblock_t));

    if (block->user > (void **)0x100)
    {
        // smaller values are not pointers
        // Note: OS-dependend?

        // clear the user's mark
        *block->user = 0;
    }

    // mark as free
    block->user = NULL;
    block->tag = 0;


#ifndef GBA
    running_count -= block->size;
#endif

    other = block->prev;

    if (!other->user)
    {
        // merge with previous free block
        other->size += block->size;
        other->next = block->next;
        other->next->prev = other;

        if (block == zone->rover)
            zone->rover = other;

        block = other;
    }

    other = block->next;
    if (!other->user)
    {
        // merge the next free block onto the end
        block->size += other->size;
        block->next = other->next;
        block->next->prev = block;

        if (other == zone->rover)
            zone->rover = block;
    }
}

unsigned int Z_ZoneFreeMemory(void)
{
    unsigned int total = 0;
    for (int i = 0; i < zoneCount; i++)
    {
        memzone_t* zone = zones[i];
        for (memblock_t* block = zone->blocklist.next;
             block != &zone->blocklist; block = block->next)
        {
            if (!block->user)
                total += block->size;
        }
    }
    return total;
}

unsigned int Z_ZoneLargestFree(void)
{
    unsigned int largest = 0;
    for (int i = 0; i < zoneCount; i++)
    {
        memzone_t* zone = zones[i];
        for (memblock_t* block = zone->blocklist.next;
             block != &zone->blocklist; block = block->next)
        {
            if (!block->user && block->size > largest)
                largest = block->size;
        }
    }
    return largest;
}

static void Z_DumpZones(void)
{
    for (int i = 0; i < zoneCount; i++)
    {
        memzone_t* zone = zones[i];
        printf("[zone] %d size=%u", i, zoneSizes[i]);
        for (memblock_t* block = zone->blocklist.next;
             block != &zone->blocklist; block = block->next)
        {
            printf(" %u:%u:%c", block->size, block->tag,
                   block->user ? 'U' : 'F');
        }
        printf("\n");
    }
}



//
// Z_Malloc
// You can pass a NULL user if the tag is < PU_PURGELEVEL.
//
#define MINFRAGMENT		64


static void* Z_TryMallocInZone(memzone_t* zone, int size, int tag, void **user)
{
    int		extra;
    memblock_t*	start;
    memblock_t* rover;
    memblock_t* newblock;
    memblock_t*	base;

    size = (size + 3) & ~3;

    // scan through the block list,
    // looking for the first free block
    // of sufficient size,
    // throwing out any purgable blocks along the way.

    // account for size of block header
    size += sizeof(memblock_t);

    // if there is a free block behind the rover,
    //  back up over them
    base = zone->rover;

    if (!base->prev->user)
    base = base->prev;

    rover = base;
    start = base->prev;

    do
    {
        if (rover == start)
        {
            // scanned all the way around this zone
            return NULL;
        }

        if (rover->user)
        {
            if (rover->tag < PU_PURGELEVEL)
            {
                // hit a block that can't be purged,
                //  so move base past it
                base = rover = rover->next;
            }
            else
            {
                // free the rover block (adding the size to base)

                // the rover can be the base block
                base = base->prev;
                Z_Free ((byte *)rover+sizeof(memblock_t));
                base = base->next;
                rover = base->next;
            }
        }
        else
            rover = rover->next;

    } while (base->user || base->size < size);


    // found a block big enough
    extra = base->size - size;

    if (extra >  MINFRAGMENT)
    {
        // there will be a free fragment after the allocated block
        newblock = (memblock_t *) ((byte *)base + size );
        newblock->size = extra;

        // NULL indicates free block.
        newblock->user = NULL;
        newblock->tag = 0;
        newblock->prev = base;
        newblock->next = base->next;
        newblock->next->prev = newblock;

        base->next = newblock;
        base->size = size;
    }

    if (user)
    {
        // mark as an in use block
        base->user = user;
        *(void **)user = (void *) ((byte *)base + sizeof(memblock_t));
    }
    else
    {
        if (tag >= PU_PURGELEVEL)
            I_Error ("Z_Malloc: an owner is required for purgable blocks");

        // mark as in use, but unowned
        base->user = (void *)2;
    }

    base->tag = tag;

    // next allocation will start looking here
    zone->rover = base->next;

#ifndef GBA
    running_count += base->size;
#endif

    return (void *) ((byte *)base + sizeof(memblock_t));
}

void* Z_Malloc(int size, int tag, void **user)
{
    int order[MAX_ZONES];
    int count = 0;

    const boolean largeLevelAllocation =
        (tag == PU_LEVEL || tag == PU_LEVSPEC) && size >= 30 * 1024;

    if (largeLevelAllocation && levelZoneIndex >= 0)
        order[count++] = levelZoneIndex;

    for (int i = 0; i < zoneCount; i++)
        if (i != levelZoneIndex)
            order[count++] = i;

    if (levelZoneIndex >= 0 && !largeLevelAllocation)
        order[count++] = levelZoneIndex;

    for (int position = 0; position < count; position++)
    {
        void* result = Z_TryMallocInZone(zones[order[position]], size, tag, user);
        if (result)
            return result;
    }

    Z_DumpZones();
    I_Error("Z_Malloc: failed on allocation of %i bytes tag=%i (free=%u largest=%u)",
            size, tag, Z_ZoneFreeMemory(), Z_ZoneLargestFree());
    return NULL;
}

void* Z_Calloc(size_t count, size_t size, int tag, void **user)
{
    const size_t bytes = count * size;
    void* ptr = Z_Malloc(bytes, tag, user);

    if(ptr)
        memset(ptr, 0, bytes);

    return ptr;
}

char* Z_Strdup(const char* s)
{
    const unsigned int len = strlen(s);

    if(!len)
        return NULL;

    char* ptr = Z_Malloc(len+1, PU_STATIC, NULL);

    if(ptr)
        strcpy(ptr, s);

    return ptr;
}

void* Z_Realloc(void *ptr, size_t n, int tag, void **user)
{
    void *p = Z_Malloc(n, tag, user);

    if (ptr)
    {
        memblock_t *block = (memblock_t *)((char *) ptr - sizeof(memblock_t));

        memcpy(p, ptr, n <= block->size ? n : block->size);

        Z_Free(ptr);

        if (user) // in case Z_Free nullified same user
            *user = p;
    }
    return p;
}

//
// Z_FreeTags
//
void Z_FreeTags(int lowtag, int hightag)
{
    memblock_t*	block;
    memblock_t*	next;

    for (int i = 0; i < zoneCount; i++)
    {
        memzone_t* zone = zones[i];
        for (block = zone->blocklist.next ;
             block != &zone->blocklist ;
             block = next)
        {
            // get link before freeing
            next = block->next;

            // free block?
            if (!block->user)
                continue;

            if (block->tag >= lowtag && block->tag <= hightag)
                Z_Free ( (byte *)block+sizeof(memblock_t));
        }
    }
}

//
// Z_CheckHeap
//
void Z_CheckHeap (void)
{
    memblock_t*	block;

    for (int i = 0; i < zoneCount; i++)
    {
        memzone_t* zone = zones[i];
        for (block = zone->blocklist.next ; ; block = block->next)
        {
            if (block->next == &zone->blocklist)
            {
                // all blocks have been hit
                break;
            }

            if ( (byte *)block + block->size != (byte *)block->next)
                I_Error ("Z_CheckHeap: block size does not touch the next block\n");

            if ( block->next->prev != block)
                I_Error ("Z_CheckHeap: next block doesn't have proper back link\n");

            if (!block->user && !block->next->user)
                I_Error ("Z_CheckHeap: two consecutive free blocks\n");
        }
    }
}
