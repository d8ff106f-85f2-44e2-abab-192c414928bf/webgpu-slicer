const canvas = document.querySelector('canvas');
let dragX = 0;
let dragY = 0;
let dragT = 0;
let viewQuat = Quat(0.5,0.5,0.5,0.5);
let frame_queued = false;
let slider_value = document.getElementById("scale").value;
let drawframe = function(timestamp) {};

document.getElementById("scale").addEventListener("input", handle_slider);
canvas.addEventListener("mousemove", handle_move);
canvas.addEventListener("touchmove", handle_touch);
canvas.addEventListener("mousedown",  handle_down);
canvas.addEventListener("touchstart", handle_down);
document.addEventListener("mouseup", handle_up);
document.addEventListener("touchend", handle_up);

main();

async function main() {
    const vert_wgsl = await (await fetch('vert.wgsl')).text();
    const frag_wgsl = await (await fetch('frag.wgsl')).text();

    const adapter = await navigator.gpu?.requestAdapter({
        featureLevel: 'compatibility',
    });
    const device = await adapter?.requestDevice();
    quitIfWebGPUNotAvailableOrMissingFeatures(adapter, device);

    const context = canvas.getContext('webgpu');
    canvas.width = canvas.clientWidth * window.devicePixelRatio;
    canvas.height = canvas.clientHeight * window.devicePixelRatio;

    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device,
        format: presentationFormat,
    });
    

    const vertex_stride = 4 * 3;
    const vertex_data = new Float32Array([
        -1,-1,-1,
         1,-1,-1,
        -1, 1,-1,
         1, 1,-1,
        -1,-1, 1,
         1,-1, 1,
        -1, 1, 1,
         1, 1, 1,
    ]);
    const vertex_buffer = device.createBuffer({
        size: vertex_data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
    });
    new Float32Array(vertex_buffer.getMappedRange()).set(vertex_data);
    vertex_buffer.unmap();


    const cube_indices_length = 3 * 12;
    const index_data_type = 'uint32';
    const index_data = new Uint32Array([
        0, 1, 5,
        5, 4, 0,
        0, 4, 6,
        6, 2, 0,
        0, 2, 3,
        3, 1, 0,
        7, 6, 4,
        4, 5, 7,
        7, 5, 1,
        1, 3, 7,
        7, 3, 2,
        2, 6, 7,
    ]);
    const index_buffer = device.createBuffer({
        size: index_data.byteLength,
        usage: GPUBufferUsage.INDEX,
        mappedAtCreation: true,
    });
    new Uint32Array(index_buffer.getMappedRange()).set(index_data);
    index_buffer.unmap();


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
            topology: 'triangle-list', // 'line-list',
            cullMode: 'back',
        },
        depthStencil: {
            depthWriteEnabled: true,
            depthCompare: 'greater',
            format: 'depth24plus',
        },
    });

    const depthTexture = device.createTexture({
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

    drawframe = function(timestamp) {
        const w = canvas.clientWidth * window.devicePixelRatio;
        const h = canvas.clientHeight * window.devicePixelRatio;
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
        
        v[12] = 0.0;
        v[13] = 0.0;
        v[14] =-8.0;
        v[15] = 1.0;

        const testarr = new Float32Array([slider_value, slider_value, slider_value]);
        device.queue.writeBuffer(vertex_buffer, 84, testarr.buffer, testarr.byteOffset, testarr.byteLength);

        device.queue.writeBuffer(cameraBuffer, 0, p.buffer, p.byteOffset, p.byteLength);
        device.queue.writeBuffer(modelBuffer, 0, v.buffer, v.byteOffset, v.byteLength);

        renderPassDescriptor.colorAttachments[0].view = context.getCurrentTexture().createView();
        const commandEncoder = device.createCommandEncoder();
        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, uniformBindGroup);
        passEncoder.setVertexBuffer(0, vertex_buffer);
        passEncoder.setIndexBuffer(index_buffer, index_data_type);
        passEncoder.drawIndexed(cube_indices_length);
        passEncoder.end();
        device.queue.submit([commandEncoder.finish()]);
        frame_queued = false;
    }

    frame_queued = true;
    requestAnimationFrame(drawframe);

}

function handle_slider(event) {
    slider_value = event.target.value;
    if (!frame_queued) {
        frame_queued = true;
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
        const sens = 16.0 * Math.PI / 10800.0; // 16 arcmin per count
        const rad = Math.sqrt(rr) * sens;
        const rot = Quat(
            Math.sin(rad/2) * (-ry) / Math.sqrt(rr),
            Math.sin(rad/2) * (-rx) / Math.sqrt(rr),
            0,
            Math.cos(rad/2),
        )
        viewQuat = viewQuat.compose(rot);
        if (!frame_queued) {
            frame_queued = true;
            requestAnimationFrame(drawframe);
        }
    }
}

function handle_touch(event) {
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