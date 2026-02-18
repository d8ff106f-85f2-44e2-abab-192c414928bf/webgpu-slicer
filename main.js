const canvas = document.getElementById('canvas');
const button = document.getElementById('button');
let dragX = 0;
let dragY = 0;
let dragT = 0;
let viewQuat = Quat(0,0,Math.sqrt(0.5),Math.sqrt(0.5));
let viewPos = [-152, 99, -166];
let slider_value = document.getElementById("scale").value;
let last_slider_value = 0;
let slicer_wasm = {};
let slicer_data = 0;
let drawframe = function(timestamp) {};

document.getElementById("scale").addEventListener("input", handle_slider);
canvas.addEventListener("mousemove", handle_move);
canvas.addEventListener("touchmove", handle_touch);
canvas.addEventListener("mousedown",  handle_down);
canvas.addEventListener("touchstart", handle_down);
window.addEventListener("mouseup", handle_up);
window.addEventListener("touchend", handle_up);
window.addEventListener("resize", handle_resize);
window.addEventListener("wheel", handle_wheel);
button.addEventListener("click", init );
window.frame_queued = false;

async function init() {

    const button = document.getElementById('button');
    button.disabled = true;
    button.textContent = 'Reading model...';
    
    const upload = document.getElementById('upload');

    const file_stream = upload.files[0].stream();
    const file_size = upload.files[0].size;


    const parser_memory = new WebAssembly.Memory({
        initial: 17,
        maximum: 65536,
    });

    const parser = await WebAssembly.instantiateStreaming(
        await fetch("wasm-parser.wasm"),
        {
            env: { 
                memory: parser_memory,
                log_node_start: ()=>console.log("parsing nodes..."), 
                log_elem_start: ()=>console.log("parsing elems..."),
            },
        },
    );

    const file_ptr = parser.instance.exports.initMemory(file_size);
    if (file_ptr == 0) {
        console.log("failed to init parser memory");
        return;
    }

    const destination = new Uint8Array(parser_memory.buffer, file_ptr, file_size);
    let offset = 0;
    for await (const chunk of file_stream) {
        destination.set(chunk, offset);
        offset += chunk.length;
    }

    console.log("parsing model...");
    button.textContent = 'Processing model...';
    const meta_ptr = parser.instance.exports.parseModel(file_ptr, file_size);
    if (meta_ptr == 0) {
        console.log("failed to parse model");
        return;
    }

    const meta = new Uint32Array(parser_memory.buffer, meta_ptr, 7);
    
    const nodes_count = meta[0];
    const elems_count = meta[1];
    const nodes_x_ptr = meta[2];
    const nodes_y_ptr = meta[3];
    const nodes_z_ptr = meta[4];
    const elems_v_ptr = meta[5];
    const nodes_n_ptr = meta[6];

    const xs_src = new Float32Array(parser_memory.buffer, nodes_x_ptr, nodes_count);
    const ys_src = new Float32Array(parser_memory.buffer, nodes_y_ptr, nodes_count);
    const zs_src = new Float32Array(parser_memory.buffer, nodes_z_ptr, nodes_count);
    const tets_src = new Uint32Array(parser_memory.buffer, elems_v_ptr, elems_count * 4);
    const ns_src = new Uint32Array(parser_memory.buffer, nodes_n_ptr, nodes_count);

    const slicer_memory = new WebAssembly.Memory({
        initial: 17,
        maximum: 65536,
    });

    const slicer = await WebAssembly.instantiateStreaming(
        await fetch("wasm-slicer.wasm"),
        {
            env: { 
                memory: slicer_memory,
            },
        },
    );


    const data_ptr = slicer.instance.exports.initMemory(nodes_count, elems_count);
    if (data_ptr == 0) {
        console.log("failed to init slicer memory");
        return;
    }

    const data = new Uint32Array(slicer_memory.buffer, data_ptr, 26);

    const ns_dst = new Uint32Array(slicer_memory.buffer, data[1], nodes_count);
    const xs_dst = new Float32Array(slicer_memory.buffer, data[2], nodes_count);
    const ys_dst = new Float32Array(slicer_memory.buffer, data[3], nodes_count);
    const zs_dst = new Float32Array(slicer_memory.buffer, data[4], nodes_count);
    const tets_dst = new Uint32Array(slicer_memory.buffer, data[13], elems_count * 4);

    ns_dst.set(ns_src);
    xs_dst.set(xs_src);
    ys_dst.set(ys_src);
    zs_dst.set(zs_src);
    tets_dst.set(tets_src);

    console.log(ns_dst[0]);
    console.log(xs_dst[0]);
    console.log(ys_dst[0]);
    console.log(zs_dst[0]);

    console.log(ns_dst[nodes_count-1]);
    console.log(xs_dst[nodes_count-1]);
    console.log(ys_dst[nodes_count-1]);
    console.log(zs_dst[nodes_count-1]);

    console.log("reoreinting...");
    button.textContent = 'Reorienting...';
    slicer.instance.exports.reorient(data_ptr, 0,0,0,1 );

    console.log("reslicing...");
    button.textContent = 'Reslicing...';
    const cuts = slicer.instance.exports.reslice(data_ptr, slider_value);
    console.log(cuts);

    const vertex_data = new Float32Array(slicer_memory.buffer, data[0], elems_count * 4 * 6);
    const vertex_stride = 4 * 3;



    const vert_wgsl = await (await fetch('vert.wgsl')).text();
    const frag_wgsl = await (await fetch('frag.wgsl')).text();

    const adapter = await navigator.gpu?.requestAdapter({
        featureLevel: 'compatibility',
    });
    const device = await adapter?.requestDevice({
        requiredLimits: {
            maxBufferSize: 512*1024*1024,
        }
    });
    quitIfWebGPUNotAvailableOrMissingFeatures(adapter, device);

    const context = canvas.getContext('webgpu');
    canvas.width = canvas.clientWidth * window.devicePixelRatio;
    canvas.height = canvas.clientHeight * window.devicePixelRatio;

    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device,
        format: presentationFormat,
    });
    

    const vertex_buffer = device.createBuffer({
        size: vertex_data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });


    const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
            module: device.createShaderModule({
                code: vert_wgsl,
            }),
            buffers: [
                {
                    arrayStride: vertex_stride,
                    attributes: [
                        {
                            shaderLocation: 0,
                            offset: 0,
                            format: 'float32x3',
                        },
                    ],
                },
            ],
        },
        fragment: {
            module: device.createShaderModule({
                code: frag_wgsl,
            }),
            targets: [
                {
                    format: presentationFormat,
                },
            ],
        },
        primitive: {
            topology: 'line-list',
            cullMode: 'back',
        },
        depthStencil: {
            depthWriteEnabled: true,
            depthCompare: 'greater',
            format: 'depth24plus',
        },
    });

    let depthTexture = device.createTexture({
        size: [canvas.width, canvas.height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const cameraBuffer = device.createBuffer({
        size: 4 * 16, // 4x4 matrix
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const modelBuffer = device.createBuffer({
        size: 4 * 16, // 4x4 matrix
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const uniformBindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: cameraBuffer },
            { binding: 1, resource: modelBuffer },
        ],
    });

    const renderPassDescriptor = {
        colorAttachments: [
            {
                view: undefined, // Assigned later
                clearValue: [0.0, 0.0, 0.0, 0.0],
                loadOp: 'clear',
                storeOp: 'store',
            },
        ],
        depthStencilAttachment: {
            view: depthTexture.createView(),
            depthClearValue: 0.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
        },
    };

    const projMatrix = new Float32Array(16);
    const viewMatrix = new Float32Array(16);

    let draw_verts_count = 0;
    drawframe = function(timestamp) {
        const currentTexture = context.getCurrentTexture();

        const w = currentTexture.width;
        const h = currentTexture.height;
        const f = Math.sqrt(w*w + h*h);
        const p = projMatrix;
        const v = viewMatrix;
        [ p[ 0] , p[ 4] , p[ 8] , p[12] ] = [ 1/w , 0.0 , 0.0 , 0.0 ];
        [ p[ 1] , p[ 5] , p[ 9] , p[13] ] = [ 0.0 , 1/h , 0.0 , 0.0 ];
        [ p[ 2] , p[ 6] , p[10] , p[14] ] = [ 0.0 , 0.0 , 0.0 , 1/f ];
        [ p[ 3] , p[ 7] , p[11] , p[15] ] = [ 0.0 , 0.0 ,-1/f , 0.0 ];
        
        [ v[ 0] , v[ 4] , v[ 8] ,
          v[ 1] , v[ 5] , v[ 9] ,
          v[ 2] , v[ 6] , v[10] ] = viewQuat.asColMat();
        [ v[ 3] , v[ 7] , v[11] ] = [ 0.0 , 0.0 , 0.0 ];
        
        v[12] = viewPos[0];
        v[13] = viewPos[1];
        v[14] = viewPos[2];
        v[15] = 1.0;

        device.queue.writeBuffer(cameraBuffer, 0, p.buffer, p.byteOffset, p.byteLength);
        device.queue.writeBuffer(modelBuffer, 0, v.buffer, v.byteOffset, v.byteLength);

        if (last_slider_value != slider_value) {            
            last_slider_value = slider_value

            console.log("reslicing...");
            const cuts = slicer.instance.exports.reslice(data_ptr, slider_value);
            console.log(cuts);

            const update_bytes = cuts * 6 * 4; // six f32 per cut
            draw_verts_count = cuts * 2; // two verts per cut
            device.queue.writeBuffer(vertex_buffer, 0, vertex_data.buffer, vertex_data.byteOffset, update_bytes);

        }

        if (!depthTexture ||
            depthTexture.width  !== w ||
            depthTexture.height !== h) {
            if (depthTexture) {
                depthTexture.destroy();
            }
            depthTexture = device.createTexture({
                size: [w, h],
                format: 'depth24plus',
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
            });
        }
        renderPassDescriptor.depthStencilAttachment.view = depthTexture.createView();
        renderPassDescriptor.colorAttachments[0].view = currentTexture.createView();

        const commandEncoder = device.createCommandEncoder();
        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, uniformBindGroup);
        passEncoder.setVertexBuffer(0, vertex_buffer);
        passEncoder.draw(draw_verts_count);
        passEncoder.end();
        device.queue.submit([commandEncoder.finish()]);
        window.frame_queued = false;
    }

    window.frame_queued = true;
    requestAnimationFrame(drawframe);

    button.textContent = 'Done.';
}

function handle_wheel(event) {
    viewPos[2] -= event.deltaY / 12;
    if (!window.frame_queued) {
        window.frame_queued = true;
        requestAnimationFrame(drawframe);
    }
}

function handle_resize(event) {
    canvas.width = canvas.clientWidth * window.devicePixelRatio;
    canvas.height = canvas.clientHeight * window.devicePixelRatio;
    if (!window.frame_queued) {
        window.frame_queued = true;
        requestAnimationFrame(drawframe);
    }
}

function handle_slider(event) {
    slider_value = event.target.value;
    if (!window.frame_queued) {
        window.frame_queued = true;
        requestAnimationFrame(drawframe);
    }
}

function handle_move(event) {
    if (dragT == 0) return;
    const rx = event.clientX - dragX;
    const ry = event.clientY - dragY;
    const rr = rx*rx + ry*ry;
    dragX = event.clientX;
    dragY = event.clientY;
    if (rr > 0) {
        if (Boolean(event.buttons & 2)) {
            viewPos[0] += rx * 0.125;
            viewPos[1] -= ry * 0.125;
        } else {
            const sens = 16.0 * Math.PI / 10800.0; // 16 arcmin per count
            const rad = Math.sqrt(rr) * sens;
            const rot = Quat(
                Math.sin(rad/2) * (-ry) / Math.sqrt(rr),
                Math.sin(rad/2) * (-rx) / Math.sqrt(rr),
                0,
                Math.cos(rad/2),
            )
            viewQuat = viewQuat.compose(rot);
            const m = rot.asColMat();
            const [ x , y , z ] = viewPos;
            viewPos[0] = m[0]*x + m[1]*y + m[2]*z;
            viewPos[1] = m[3]*x + m[4]*y + m[5]*z;
            viewPos[2] = m[6]*x + m[7]*y + m[8]*z;
        }
        if (!window.frame_queued) {
            window.frame_queued = true;
            requestAnimationFrame(drawframe);
        }
    }
}

function handle_touch(event) {
    if (event.touches.length == 0) return;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < event.touches.length; i++) {
        dx += event.touches[i].clientX;
        dy += event.touches[i].clientY;
    }
    if (dx == 0 && dy == 0) return;
    event.clientX = dx / event.touches.length;
    event.clientY = dy / event.touches.length;
    handle_move(event);
}

function handle_down(event) {
    dragX = event.clientX;
    dragY = event.clientY;
    dragT = event.timeStamp;
}

function handle_up(event) {
    dragT = 0;
}

function Quat(i,j,k,l) {
    return {
        i,
        j,
        k,
        l,

        exp() {
            const i = this.i;
            const j = this.j;
            const k = this.k;
            const l = this.l;
            const ijk = Math.sqrt(i*i + j*j + k*k);
            const cos = Math.cos(ijk);
            const sin = Math.sin(ijk);
            const mag = Math.exp(l);
            return Quat(
                mag * sin * i / ijk,
                mag * sin * j / ijk,
                mag * sin * k / ijk,
                mag * cos,
            );
        },

        log() {
            const i = this.i;
            const j = this.j;
            const k = this.k;
            const l = this.l;
            const ll = l*l;
            const rr = i*i + j*j + k*k;
            const ang = Math.atan2(Math.sqrt(rr), Math.sqrt(ll));
            const ijk = Math.sqrt(rr);
            return Quat(
                ang * i / ijk,
                ang * j / ijk,
                ang * k / ijk,
                0.5 * Math.log(ll + rr),
            );
        },

        outer(that) {
            return [
                this.i * that.i, this.i * that.j, this.i * that.k, this.i * that.l,
                this.j * that.i, this.j * that.j, this.j * that.k, this.j * that.l,
                this.k * that.i, this.k * that.j, this.k * that.k, this.k * that.l,
                this.l * that.i, this.l * that.j, this.l * that.k, this.l * that.l,
            ];
        },

        compose(that) {
            const [ ii , ij , ik , il , 
                    ji , jj , jk , jl , 
                    ki , kj , kk , kl , 
                    li , lj , lk , ll ] = this.outer(that);
            return Quat(
                li - kj + jk + il, 
                lj + ki + jl - ik, 
                lk + kl - ji + ij, 
                ll - kk - jj - ii,
            );
        },

        asColMat() {
            const [ ii , ij , ik , il , 
                    ji , jj , jk , jl , 
                    ki , kj , kk , kl , 
                    li , lj , lk , ll ] = this.outer(this);
            return [
                (ll+ii)-(jj+kk), 
                (ij+ji)+(lk+kl), 
                (ki+ik)-(lj+jl), 

                (ij+ji)-(lk+kl),
                (ll+jj)-(kk+ii),
                (jk+kj)+(li+il),

                (ki+ik)+(lj+jl),                
                (jk+kj)-(li+il),
                (ll+kk)-(ii+jj),                
            ];
        },
    };
};